#!/usr/bin/env python3
"""
One-shot diagnostic: dump the DeepSeek chat page's input elements.

Connects to the app's Chrome instance over CDP, navigates to
DeepSeek, and prints every textarea, contenteditable, and input
element it finds — with their aria-labels, placeholders, class
names, and visibility. Used to discover the correct selector for
the chat input.

Run from the scripts folder:
    python debug_deepseek.py
"""

import json
import sys
import time
from pathlib import Path

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from core.browser import connect_to_chrome


def main() -> int:
    port = 9222

    print(f"Connecting to Chrome on port {port}...")
    browser = connect_to_chrome(port)
    context = browser.contexts[0] if browser.contexts else None
    if context is None:
        print("ERROR: Chrome has no browser context.")
        return 1

    page = context.pages[0] if context.pages else context.new_page()

    print("Navigating to DeepSeek...")
    page.goto(
        "https://chat.deepseek.com/",
        timeout=30000,
        wait_until="domcontentloaded",
    )
    time.sleep(3.0)

    result = page.evaluate(
        """() => {
            const out = {};
            out.url = window.location.href;
            out.title = document.title;

            out.textareas = Array.from(
                document.querySelectorAll('textarea')
            ).map(t => ({
                ariaLabel: t.getAttribute('aria-label'),
                placeholder: t.getAttribute('placeholder'),
                className: t.className,
                id: t.id,
                name: t.getAttribute('name'),
                visible: t.offsetParent !== null,
                disabled: t.disabled,
            }));

            out.contenteditables = Array.from(
                document.querySelectorAll('[contenteditable="true"]')
            ).map(c => ({
                tagName: c.tagName,
                ariaLabel: c.getAttribute('aria-label'),
                placeholder: c.getAttribute('placeholder'),
                className: c.className,
                id: c.id,
                role: c.getAttribute('role'),
                visible: c.offsetParent !== null,
            }));

            out.inputs = Array.from(
                document.querySelectorAll('input')
            ).map(i => ({
                type: i.type,
                ariaLabel: i.getAttribute('aria-label'),
                placeholder: i.getAttribute('placeholder'),
                className: i.className,
                id: i.id,
                visible: i.offsetParent !== null,
            }));

            return out;
        }"""
    )

    print()
    print("=" * 70)
    print("DEEPSEEK CHAT PAGE — INPUT ELEMENT DUMP")
    print("=" * 70)
    print(json.dumps(result, indent=2))
    print("=" * 70)

    return 0


if __name__ == "__main__":
    sys.exit(main())