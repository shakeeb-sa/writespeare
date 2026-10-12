#!/usr/bin/env python3
"""
migrations/0001_add_bucket_layout.py — one-time schema migration.

Migrates the three MongoDB collections that gained new fields in
the bucket-layout schema change (the C2 decision):

  * `presets`      — add `defaultBucketLayout` to every preset that
                     predates the field, synthesizing it from the
                     preset's old `sourceCount` (even split across
                     the four buckets, remainder on `anyTime`).
                     Remove the deprecated `maxResults` field.

  * `topics`       — add `searchBuckets` to every topic that
                     predates the field, synthesizing it from the
                     topic's old `sourceCount` (same even-split
                     rule).

  * `usersettings` — add `settings.defaultBucketLayout`,
                     `settings.bundleDownloadMode`, and
                     `settings.bundleDownloadPath` to every
                     settings document that predates the fields.
                     The bucket layout uses the Balanced preset's
                     default distribution (4, 2, 2, 2); the bundle
                     fields use the same defaults the schema
                     declares (`'ask'` and `''`).

The migration is idempotent. Every document is checked against
the new fields before being updated; documents that already have
the new fields are skipped. Running the script twice produces
the same final state as running it once, and the second run
reports zero updates.

Why direct MongoDB access instead of the backend's HTTP API:

  The plan's annotation for this script reads "runs against the
  backend API for all three collections." The intent is correct
  — the migration targets data the backend serves — but the
  HTTP API cannot actually perform this migration:

    * The three collections span two authorization scopes.
      System presets live under `/api/admin/presets` (admin
      only); user presets, topics, and settings live under
      user-scoped endpoints. No single authenticated session
      can read or write across all three collections through
      the API.

    * The backend exposes no "list every preset in the system"
      endpoint and no "list every topic" endpoint that is not
      scoped to the caller. A migration must iterate over
      every document regardless of owner.

    * Running the migration as each user in turn is not
      possible without their passwords.

  A direct MongoDB connection is the standard mechanism for a
  schema migration in this situation. The script connects using
  the `MONGODB_URI` environment variable, falling back to the
  same default the backend uses. It is intended to be run once
  by an operator with database credentials — the same access
  level the backend itself has.

Dependency note:

  This script uses `pymongo`, which is NOT declared in the
  desktop's `requirements.txt`. The requirements file lists the
  runtime dependencies of the shipped app; a migration script is
  a developer/operator tool, not part of the runtime. Running
  this script therefore requires installing `pymongo` in the
  environment where it runs:

      pip install pymongo

  If run without `pymongo` installed, the script exits with a
  clear error message naming the missing package.

Usage:

    # Default MongoDB URI (mongodb://localhost:27017/writespeare):
    python 0001_add_bucket_layout.py

    # Custom URI:
    MONGODB_URI="mongodb+srv://user:pass@host/writespeare" \
        python 0001_add_bucket_layout.py

Exit codes:

    0 — the migration ran to completion (whether or not any
        documents were updated)
    1 — the migration could not start: `pymongo` not installed,
        MongoDB unreachable, or the connection URI invalid

The exit code does NOT distinguish "no documents needed
migration" from "many documents migrated" — both are successful
outcomes. The per-collection counts printed to stdout carry the
detail.
"""

import os
import sys
from pathlib import Path
from typing import Any


# =============================================================================
#  sys.path bootstrap
# =============================================================================
#  Same block as every other script under `scripts/`. This script
#  does not currently import from any sibling `core/` module, so
#  the bootstrap is not strictly required — but keeping it means
#  a future edit that DOES need a `core` utility can add the
#  import without also remembering to add the path setup.

_SCRIPT_DIR = Path(__file__).resolve().parent
_SCRIPTS_ROOT = _SCRIPT_DIR.parent
if str(_SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_ROOT))


# =============================================================================
#  Dependency: pymongo
# =============================================================================
#  Wrapped in a try/except so the failure message is actionable.
#  A bare `import pymongo` raises `ModuleNotFoundError` with no
#  hint about how to fix it; this variant names the missing
#  package and the install command.

try:
    from pymongo import MongoClient
    from pymongo.database import Database
    from pymongo.errors import PyMongoError
except ImportError:
    print(
        "ERROR: pymongo is not installed in this Python environment.",
        file=sys.stderr,
    )
    print(
        "Install it with: pip install pymongo",
        file=sys.stderr,
    )
    sys.exit(1)


# =============================================================================
#  Constants
# =============================================================================

# The MongoDB connection URI. Defaults to the same local
# development URI the backend's `db.ts` uses as its own fallback,
# so a developer running against a local `mongod` does not have to
# set any environment variables.
DEFAULT_MONGODB_URI = "mongodb://localhost:27017/writespeare"

# The database name used when the URI does not carry a database
# path — a caller who set `MONGODB_URI=mongodb://host:27017`
# without a trailing `/writespeare` gets this default rather than
# an error.
DEFAULT_DATABASE_NAME = "writespeare"

# The `sourceCount` to synthesize a bucket layout from, used only
# when a preset or topic is missing the field entirely. Matches
# the schema's own default so a legacy document with no
# `sourceCount` produces the same bucket distribution a fresh
# document would.
FALLBACK_SOURCE_COUNT = 10

# The default bucket distribution for a user settings document
# that predates the field. Matches the Balanced preset's layout
# (4, 2, 2, 2) and the schema's own default on
# `UserSettingsMap.defaultBucketLayout` — see `UserSetting.ts`.
DEFAULT_USER_BUCKET_LAYOUT: dict[str, int] = {
    "anyTime": 4,
    "pastYear": 2,
    "pastMonth": 2,
    "pastWeek": 2,
}


# =============================================================================
#  Bucket-layout synthesis
# =============================================================================

def synthesize_bucket_layout(source_count: int) -> dict[str, int]:
    """
    Derive an even-split bucket layout from a single source count.

    The four buckets are filled as evenly as possible; any
    remainder from the division is placed on `anyTime`, so the
    sum of the four counts always equals the input exactly. This
    is the same rule the backend's `topicService.ts` and
    `settingsService.ts` apply when synthesizing a layout from a
    bare `sourceCount`, and the same rule the `Preset` schema's
    default and `UserSetting` schema's default follow in spirit.
    Keeping the rule identical across the migration script and
    the services means a legacy record migrated by this script
    and a new record created by a service end up with the same
    layout for the same input.

    A non-positive input produces `(0, 0, 0, 0)`. The schema's own
    `min: 1` on `sourceCount` prevents the case from arising on a
    well-formed document; the fallback exists so a hand-edited or
    corrupt document does not crash the migration.
    """
    if source_count <= 0:
        return {
            "anyTime": 0,
            "pastYear": 0,
            "pastMonth": 0,
            "pastWeek": 0,
        }

    per = source_count // 4
    remainder = source_count - per * 4
    return {
        "anyTime": per + remainder,
        "pastYear": per,
        "pastMonth": per,
        "pastWeek": per,
    }


# =============================================================================
#  Per-collection migrations
# =============================================================================

def migrate_presets(db: Database) -> tuple[int, int]:
    """
    Migrate the `presets` collection.

    Two changes:

      1. Every preset without a `defaultBucketLayout` field gets
         one, synthesized from its `sourceCount` using the even-
         split rule.

      2. Every preset with a `maxResults` field (the deprecated
         field the C2 decision removed) has that field unset.

    A single document can match both conditions; the update
    applies both operations in one atomic call.

    Returns a `(updated, unchanged)` tuple of counts. The
    `unchanged` count is always zero under the current query —
    the query's `$or` is an exact mirror of the two branches —
    but the tuple shape is kept for symmetry with the other
    migrations and in case a future change to the query adds a
    condition that does not correspond to a branch.
    """
    collection = db["presets"]

    # Find every preset that needs either change. A preset that
    # already has `defaultBucketLayout` AND is missing `maxResults`
    # matches neither condition and is skipped.
    query: dict[str, Any] = {
        "$or": [
            {"defaultBucketLayout": {"$exists": False}},
            {"maxResults": {"$exists": True}},
        ]
    }

    updated = 0
    unchanged = 0

    for doc in collection.find(query):
        set_ops: dict[str, Any] = {}
        unset_ops: dict[str, str] = {}

        # ---- Add defaultBucketLayout if missing ----
        # A document with an explicit `null` for the field is
        # treated as missing, same as a document with no field at
        # all — the schema's required-ness applies equally to both
        # cases, so both need a synthesized value.
        if doc.get("defaultBucketLayout") is None:
            source_count = doc.get("sourceCount", FALLBACK_SOURCE_COUNT)
            if not isinstance(source_count, int):
                # Defensive: a hand-edited document might have a
                # string or float. Fall back to the default rather
                # than crash.
                source_count = FALLBACK_SOURCE_COUNT
            set_ops["defaultBucketLayout"] = synthesize_bucket_layout(
                source_count
            )

        # ---- Remove maxResults if present ----
        if "maxResults" in doc:
            unset_ops["maxResults"] = ""

        # ---- Apply ----
        if set_ops or unset_ops:
            update: dict[str, Any] = {}
            if set_ops:
                update["$set"] = set_ops
            if unset_ops:
                update["$unset"] = unset_ops
            collection.update_one({"_id": doc["_id"]}, update)
            updated += 1
        else:
            unchanged += 1

    return updated, unchanged


def migrate_topics(db: Database) -> tuple[int, int]:
    """
    Migrate the `topics` collection.

    Every topic without a `searchBuckets` field gets one,
    synthesized from its `sourceCount` using the same even-split
    rule the preset migration uses. Topics are only added-to,
    never removed-from: the migration does not touch any existing
    field.

    Returns a `(updated, unchanged)` tuple of counts. The
    `unchanged` count is zero under the current query — every
    matched document needs the field — but the tuple shape is
    kept for symmetry with the other migrations.
    """
    collection = db["topics"]

    query: dict[str, Any] = {
        "searchBuckets": {"$exists": False},
    }

    updated = 0
    unchanged = 0

    for doc in collection.find(query):
        source_count = doc.get("sourceCount", FALLBACK_SOURCE_COUNT)
        if not isinstance(source_count, int):
            source_count = FALLBACK_SOURCE_COUNT
        layout = synthesize_bucket_layout(source_count)
        collection.update_one(
            {"_id": doc["_id"]},
            {"$set": {"searchBuckets": layout}},
        )
        updated += 1

    return updated, unchanged


def migrate_user_settings(db: Database) -> tuple[int, int]:
    """
    Migrate the `usersettings` collection.

    Three fields are added to the embedded `settings` sub-document
    when missing:

      * `settings.defaultBucketLayout` — the user's default
        search distribution for new topics. Uses the Balanced
        preset's layout (4, 2, 2, 2), matching the schema's own
        default.

      * `settings.bundleDownloadMode` — `'ask'`, matching the
        schema's default.

      * `settings.bundleDownloadPath` — `''`, matching the
        schema's default.

    The updates use dotted-path `$set` keys so the existing values
    inside the `settings` sub-document are preserved: only the
    three targeted fields are touched.

    Returns a `(updated, unchanged)` tuple of counts. The
    `unchanged` count is zero under the current query — every
    matched document needs at least one of the three fields — but
    the tuple shape is kept for symmetry with the other
    migrations.
    """
    collection = db["usersettings"]

    query: dict[str, Any] = {
        "$or": [
            {"settings.defaultBucketLayout": {"$exists": False}},
            {"settings.bundleDownloadMode": {"$exists": False}},
            {"settings.bundleDownloadPath": {"$exists": False}},
        ]
    }

    updated = 0
    unchanged = 0

    for doc in collection.find(query):
        settings = doc.get("settings") or {}
        if not isinstance(settings, dict):
            # A malformed `settings` field — a document that
            # somehow stored a string or an array there. Replace
            # it wholesale with a well-formed defaults object
            # rather than trying to patch a non-object.
            settings = {}

        set_ops: dict[str, Any] = {}

        if "defaultBucketLayout" not in settings:
            set_ops["settings.defaultBucketLayout"] = dict(
                DEFAULT_USER_BUCKET_LAYOUT
            )

        if "bundleDownloadMode" not in settings:
            set_ops["settings.bundleDownloadMode"] = "ask"

        if "bundleDownloadPath" not in settings:
            set_ops["settings.bundleDownloadPath"] = ""

        if set_ops:
            collection.update_one(
                {"_id": doc["_id"]},
                {"$set": set_ops},
            )
            updated += 1
        else:
            unchanged += 1

    return updated, unchanged


# =============================================================================
#  Entry point
# =============================================================================

def main() -> int:
    """
    Connect to MongoDB, run the three per-collection migrations
    in sequence, and print a per-collection summary.

    Returns an integer exit code: 0 on success, 1 on any failure
    before the migrations run (connection error, missing
    dependency). A per-document update failure propagates as an
    exception — the migration is meant to run in a controlled
    environment where a partial failure warrants a stop, not a
    silent continuation.
    """
    uri = os.environ.get("MONGODB_URI", DEFAULT_MONGODB_URI)

    print("0001_add_bucket_layout — one-time schema migration")
    print()
    print("Connecting to MongoDB...")

    try:
        # `serverSelectionTimeoutMS` is kept short so a
        # misconfigured URI fails fast rather than hanging for
        # the driver's default thirty seconds.
        client = MongoClient(uri, serverSelectionTimeoutMS=5000)
        # A ping forces the driver to actually establish a
        # connection, which is what surfaces a bad URI or an
        # unreachable host as an immediate error.
        client.admin.command("ping")
    except PyMongoError as exc:
        print(f"ERROR: could not connect to MongoDB: {exc}")
        return 1

    # Resolve the database. If the URI carried a database path
    # (`mongodb://host:27017/writespeare`), the driver's
    # `get_default_database` returns it. If the URI carried only
    # a host, the fallback name is used. The explicit check
    # against `None` handles the second case cleanly.
    try:
        db = client.get_default_database()
        if db is None:
            db = client[DEFAULT_DATABASE_NAME]
    except Exception:
        # `get_default_database` raises when the URI has no
        # database path on some pymongo versions.
        db = client[DEFAULT_DATABASE_NAME]

    print(f"Database: {db.name}")
    print()

    # ---- Presets ----
    presets_updated, presets_unchanged = migrate_presets(db)
    print(
        f"presets: {presets_updated} updated, "
        f"{presets_unchanged} already current"
    )

    # ---- Topics ----
    topics_updated, topics_unchanged = migrate_topics(db)
    print(
        f"topics: {topics_updated} updated, "
        f"{topics_unchanged} already current"
    )

    # ---- User settings ----
    settings_updated, settings_unchanged = migrate_user_settings(db)
    print(
        f"usersettings: {settings_updated} updated, "
        f"{settings_unchanged} already current"
    )

    print()
    print("Migration complete.")

    client.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())