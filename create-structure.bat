@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo ============================================================
echo  WriteSpeare - Project Structure Creator
echo  Working directory: %CD%
echo ============================================================
echo.

REM ============================================================
REM  ROOT
REM ============================================================
echo [ROOT] Creating workspace files...
type nul > "package.json"
type nul > ".gitignore"
type nul > ".gitattributes"
type nul > "repomix.config.json"
type nul > "README.md"
type nul > ".env.example"

REM ============================================================
REM  BACKEND - apps/server - FOLDERS
REM ============================================================
echo [SERVER] Creating folders...

mkdir "apps\server\handler" 2>nul
mkdir "apps\server\src\features\shared\config" 2>nul
mkdir "apps\server\src\features\shared\middleware" 2>nul
mkdir "apps\server\src\features\shared\types" 2>nul
mkdir "apps\server\src\features\shared\utils" 2>nul
mkdir "apps\server\src\features\auth\controllers" 2>nul
mkdir "apps\server\src\features\auth\middleware" 2>nul
mkdir "apps\server\src\features\auth\models" 2>nul
mkdir "apps\server\src\features\auth\routes" 2>nul
mkdir "apps\server\src\features\auth\services" 2>nul
mkdir "apps\server\src\features\auth\utils" 2>nul
mkdir "apps\server\src\features\admin\controllers" 2>nul
mkdir "apps\server\src\features\admin\middleware" 2>nul
mkdir "apps\server\src\features\admin\routes" 2>nul
mkdir "apps\server\src\features\admin\services" 2>nul
mkdir "apps\server\src\features\users\controllers" 2>nul
mkdir "apps\server\src\features\users\routes" 2>nul
mkdir "apps\server\src\features\users\services" 2>nul
mkdir "apps\server\src\features\topics\controllers" 2>nul
mkdir "apps\server\src\features\topics\models" 2>nul
mkdir "apps\server\src\features\topics\routes" 2>nul
mkdir "apps\server\src\features\topics\services" 2>nul
mkdir "apps\server\src\features\documents\controllers" 2>nul
mkdir "apps\server\src\features\documents\models" 2>nul
mkdir "apps\server\src\features\documents\routes" 2>nul
mkdir "apps\server\src\features\documents\services" 2>nul
mkdir "apps\server\src\features\articles\controllers" 2>nul
mkdir "apps\server\src\features\articles\models" 2>nul
mkdir "apps\server\src\features\articles\routes" 2>nul
mkdir "apps\server\src\features\articles\services" 2>nul
mkdir "apps\server\src\features\reports\controllers" 2>nul
mkdir "apps\server\src\features\reports\models" 2>nul
mkdir "apps\server\src\features\reports\routes" 2>nul
mkdir "apps\server\src\features\reports\services" 2>nul
mkdir "apps\server\src\features\settings\controllers" 2>nul
mkdir "apps\server\src\features\settings\models" 2>nul
mkdir "apps\server\src\features\settings\routes" 2>nul
mkdir "apps\server\src\features\settings\services" 2>nul
mkdir "apps\server\src\features\version\controllers" 2>nul
mkdir "apps\server\src\features\version\models" 2>nul
mkdir "apps\server\src\features\version\routes" 2>nul

REM ============================================================
REM  BACKEND - apps/server - FILES
REM ============================================================
echo [SERVER] Creating files...

type nul > "apps\server\package.json"
type nul > "apps\server\tsconfig.json"
type nul > "apps\server\vercel.json"
type nul > "apps\server\.gitignore"
type nul > "apps\server\.env"
type nul > "apps\server\.env.example"
type nul > "apps\server\handler\index.ts"
type nul > "apps\server\src\app.ts"
type nul > "apps\server\src\index.ts"
type nul > "apps\server\src\features\shared\config\db.ts"
type nul > "apps\server\src\features\shared\middleware\errorHandler.ts"
type nul > "apps\server\src\features\shared\middleware\validate.ts"
type nul > "apps\server\src\features\shared\middleware\rateLimit.ts"
type nul > "apps\server\src\features\shared\types\index.ts"
type nul > "apps\server\src\features\shared\utils\bcrypt.ts"
type nul > "apps\server\src\features\shared\utils\seedAdmin.ts"
type nul > "apps\server\src\features\auth\controllers\authController.ts"
type nul > "apps\server\src\features\auth\middleware\authGuard.ts"
type nul > "apps\server\src\features\auth\models\User.ts"
type nul > "apps\server\src\features\auth\routes\authRoutes.ts"
type nul > "apps\server\src\features\auth\services\authService.ts"
type nul > "apps\server\src\features\auth\utils\bcrypt.ts"
type nul > "apps\server\src\features\auth\utils\jwt.ts"
type nul > "apps\server\src\features\auth\index.ts"
type nul > "apps\server\src\features\admin\controllers\adminController.ts"
type nul > "apps\server\src\features\admin\middleware\adminGuard.ts"
type nul > "apps\server\src\features\admin\routes\adminRoutes.ts"
type nul > "apps\server\src\features\admin\services\adminService.ts"
type nul > "apps\server\src\features\admin\index.ts"
type nul > "apps\server\src\features\users\controllers\userController.ts"
type nul > "apps\server\src\features\users\routes\userRoutes.ts"
type nul > "apps\server\src\features\users\services\userService.ts"
type nul > "apps\server\src\features\users\index.ts"
type nul > "apps\server\src\features\topics\controllers\topicController.ts"
type nul > "apps\server\src\features\topics\models\Topic.ts"
type nul > "apps\server\src\features\topics\routes\topicRoutes.ts"
type nul > "apps\server\src\features\topics\services\topicService.ts"
type nul > "apps\server\src\features\topics\index.ts"
type nul > "apps\server\src\features\documents\controllers\documentController.ts"
type nul > "apps\server\src\features\documents\models\Document.ts"
type nul > "apps\server\src\features\documents\routes\documentRoutes.ts"
type nul > "apps\server\src\features\documents\services\documentService.ts"
type nul > "apps\server\src\features\documents\index.ts"
type nul > "apps\server\src\features\articles\controllers\articleController.ts"
type nul > "apps\server\src\features\articles\models\Article.ts"
type nul > "apps\server\src\features\articles\routes\articleRoutes.ts"
type nul > "apps\server\src\features\articles\services\articleService.ts"
type nul > "apps\server\src\features\articles\index.ts"
type nul > "apps\server\src\features\reports\controllers\reportController.ts"
type nul > "apps\server\src\features\reports\models\Report.ts"
type nul > "apps\server\src\features\reports\routes\reportRoutes.ts"
type nul > "apps\server\src\features\reports\services\reportService.ts"
type nul > "apps\server\src\features\reports\index.ts"
type nul > "apps\server\src\features\settings\controllers\settingsController.ts"
type nul > "apps\server\src\features\settings\models\UserSetting.ts"
type nul > "apps\server\src\features\settings\models\Preset.ts"
type nul > "apps\server\src\features\settings\routes\settingsRoutes.ts"
type nul > "apps\server\src\features\settings\services\settingsService.ts"
type nul > "apps\server\src\features\settings\index.ts"
type nul > "apps\server\src\features\version\controllers\versionController.ts"
type nul > "apps\server\src\features\version\models\AppVersion.ts"
type nul > "apps\server\src\features\version\routes\versionRoutes.ts"
type nul > "apps\server\src\features\version\index.ts"

REM ============================================================
REM  DESKTOP - apps/desktop - FOLDERS
REM ============================================================
echo [DESKTOP] Creating folders...

mkdir "apps\desktop\scripts" 2>nul
mkdir "apps\desktop\src\main" 2>nul
mkdir "apps\desktop\src\renderer" 2>nul
mkdir "apps\desktop\src\renderer\styles" 2>nul

mkdir "apps\desktop\src\features\shared\api" 2>nul
mkdir "apps\desktop\src\features\shared\components" 2>nul
mkdir "apps\desktop\src\features\shared\constants" 2>nul
mkdir "apps\desktop\src\features\shared\hooks" 2>nul
mkdir "apps\desktop\src\features\shared\store" 2>nul
mkdir "apps\desktop\src\features\shared\types" 2>nul
mkdir "apps\desktop\src\features\shared\utils" 2>nul

mkdir "apps\desktop\src\features\auth\api" 2>nul
mkdir "apps\desktop\src\features\auth\hooks" 2>nul
mkdir "apps\desktop\src\features\auth\ipc" 2>nul
mkdir "apps\desktop\src\features\auth\pages" 2>nul
mkdir "apps\desktop\src\features\auth\store" 2>nul
mkdir "apps\desktop\src\features\auth\types" 2>nul

mkdir "apps\desktop\src\features\topics\components" 2>nul
mkdir "apps\desktop\src\features\topics\hooks" 2>nul
mkdir "apps\desktop\src\features\topics\ipc" 2>nul
mkdir "apps\desktop\src\features\topics\pages" 2>nul
mkdir "apps\desktop\src\features\topics\services" 2>nul
mkdir "apps\desktop\src\features\topics\store" 2>nul

mkdir "apps\desktop\src\features\research\components" 2>nul
mkdir "apps\desktop\src\features\research\hooks" 2>nul
mkdir "apps\desktop\src\features\research\ipc" 2>nul
mkdir "apps\desktop\src\features\research\services" 2>nul
mkdir "apps\desktop\src\features\research\store" 2>nul

mkdir "apps\desktop\src\features\documents\components" 2>nul
mkdir "apps\desktop\src\features\documents\hooks" 2>nul
mkdir "apps\desktop\src\features\documents\ipc" 2>nul
mkdir "apps\desktop\src\features\documents\services" 2>nul
mkdir "apps\desktop\src\features\documents\store" 2>nul

mkdir "apps\desktop\src\features\writer\components" 2>nul
mkdir "apps\desktop\src\features\writer\hooks" 2>nul
mkdir "apps\desktop\src\features\writer\ipc" 2>nul
mkdir "apps\desktop\src\features\writer\services" 2>nul
mkdir "apps\desktop\src\features\writer\store" 2>nul

mkdir "apps\desktop\src\features\validation\components" 2>nul
mkdir "apps\desktop\src\features\validation\hooks" 2>nul
mkdir "apps\desktop\src\features\validation\ipc" 2>nul
mkdir "apps\desktop\src\features\validation\services" 2>nul
mkdir "apps\desktop\src\features\validation\store" 2>nul

mkdir "apps\desktop\src\features\export\components" 2>nul
mkdir "apps\desktop\src\features\export\hooks" 2>nul
mkdir "apps\desktop\src\features\export\ipc" 2>nul
mkdir "apps\desktop\src\features\export\services" 2>nul

mkdir "apps\desktop\src\features\settings\hooks" 2>nul
mkdir "apps\desktop\src\features\settings\ipc" 2>nul
mkdir "apps\desktop\src\features\settings\pages" 2>nul
mkdir "apps\desktop\src\features\settings\services" 2>nul
mkdir "apps\desktop\src\features\settings\store" 2>nul

mkdir "apps\desktop\src\features\admin\components" 2>nul
mkdir "apps\desktop\src\features\admin\hooks" 2>nul
mkdir "apps\desktop\src\features\admin\ipc" 2>nul
mkdir "apps\desktop\src\features\admin\pages" 2>nul
mkdir "apps\desktop\src\features\admin\store" 2>nul

mkdir "apps\desktop\src\features\automation\components" 2>nul
mkdir "apps\desktop\src\features\automation\hooks" 2>nul
mkdir "apps\desktop\src\features\automation\ipc" 2>nul
mkdir "apps\desktop\src\features\automation\store" 2>nul

mkdir "apps\desktop\src\resources\config" 2>nul
mkdir "apps\desktop\src\resources\images" 2>nul
mkdir "apps\desktop\src\resources\python" 2>nul
mkdir "apps\desktop\src\resources\scripts\core" 2>nul
mkdir "apps\desktop\src\resources\scripts\research" 2>nul
mkdir "apps\desktop\src\resources\scripts\writer" 2>nul
mkdir "apps\desktop\src\resources\scripts\validation" 2>nul
mkdir "apps\desktop\src\resources\scripts\export" 2>nul
mkdir "apps\desktop\src\resources\scripts\prompts" 2>nul
mkdir "apps\desktop\src\resources\scripts\migrations" 2>nul

REM ============================================================
REM  DESKTOP - apps/desktop - ROOT FILES
REM ============================================================
echo [DESKTOP] Creating root files...

type nul > "apps\desktop\package.json"
type nul > "apps\desktop\tsconfig.json"
type nul > "apps\desktop\vite.config.ts"
type nul > "apps\desktop\tailwind.config.js"
type nul > "apps\desktop\postcss.config.js"
type nul > "apps\desktop\index.html"
type nul > "apps\desktop\.gitattributes"
type nul > "apps\desktop\.gitignore"
type nul > "apps\desktop\scripts\optimize-images.mjs"

REM ============================================================
REM  DESKTOP - src/main
REM ============================================================
type nul > "apps\desktop\src\main\index.ts"
type nul > "apps\desktop\src\main\preload.ts"
type nul > "apps\desktop\src\main\protocols.ts"
type nul > "apps\desktop\src\main\store.ts"

REM ============================================================
REM  DESKTOP - src/renderer
REM ============================================================
type nul > "apps\desktop\src\renderer\index.tsx"
type nul > "apps\desktop\src\renderer\App.tsx"
type nul > "apps\desktop\src\renderer\styles\tailwind.css"

REM ============================================================
REM  DESKTOP - shared feature
REM ============================================================
type nul > "apps\desktop\src\features\shared\api\client.ts"
type nul > "apps\desktop\src\features\shared\components\Layout.tsx"
type nul > "apps\desktop\src\features\shared\components\Modal.tsx"
type nul > "apps\desktop\src\features\shared\components\Sidebar.tsx"
type nul > "apps\desktop\src\features\shared\components\Toast.tsx"
type nul > "apps\desktop\src\features\shared\constants\index.ts"
type nul > "apps\desktop\src\features\shared\hooks\useToast.ts"
type nul > "apps\desktop\src\features\shared\store\rootStore.ts"
type nul > "apps\desktop\src\features\shared\types\index.ts"
type nul > "apps\desktop\src\features\shared\utils\encryption.ts"
type nul > "apps\desktop\src\features\shared\utils\logger.ts"

REM ============================================================
REM  DESKTOP - auth feature
REM ============================================================
type nul > "apps\desktop\src\features\auth\api\authApi.ts"
type nul > "apps\desktop\src\features\auth\hooks\useAuth.ts"
type nul > "apps\desktop\src\features\auth\ipc\authIPC.ts"
type nul > "apps\desktop\src\features\auth\pages\Login.tsx"
type nul > "apps\desktop\src\features\auth\store\userStore.ts"
type nul > "apps\desktop\src\features\auth\types\authTypes.ts"

REM ============================================================
REM  DESKTOP - topics feature
REM ============================================================
type nul > "apps\desktop\src\features\topics\components\TopicCard.tsx"
type nul > "apps\desktop\src\features\topics\components\NewTopicModal.tsx"
type nul > "apps\desktop\src\features\topics\components\AdvancedSettings.tsx"
type nul > "apps\desktop\src\features\topics\components\PresetSelector.tsx"
type nul > "apps\desktop\src\features\topics\hooks\useTopics.ts"
type nul > "apps\desktop\src\features\topics\ipc\topicsIPC.ts"
type nul > "apps\desktop\src\features\topics\pages\Topics.tsx"
type nul > "apps\desktop\src\features\topics\pages\TopicDetail.tsx"
type nul > "apps\desktop\src\features\topics\services\topicsApi.ts"
type nul > "apps\desktop\src\features\topics\store\topicStore.ts"

REM ============================================================
REM  DESKTOP - research feature
REM ============================================================
type nul > "apps\desktop\src\features\research\components\SearchProgress.tsx"
type nul > "apps\desktop\src\features\research\components\SourceList.tsx"
type nul > "apps\desktop\src\features\research\components\SourceCandidate.tsx"
type nul > "apps\desktop\src\features\research\hooks\useResearch.ts"
type nul > "apps\desktop\src\features\research\ipc\researchIPC.ts"
type nul > "apps\desktop\src\features\research\services\searchService.ts"
type nul > "apps\desktop\src\features\research\services\extractionService.ts"
type nul > "apps\desktop\src\features\research\services\childProcessManager.ts"
type nul > "apps\desktop\src\features\research\services\chromeLauncher.ts"
type nul > "apps\desktop\src\features\research\services\portAllocator.ts"
type nul > "apps\desktop\src\features\research\services\listenerBridge.ts"
type nul > "apps\desktop\src\features\research\store\researchStore.ts"

REM ============================================================
REM  DESKTOP - documents feature
REM ============================================================
type nul > "apps\desktop\src\features\documents\components\DocumentList.tsx"
type nul > "apps\desktop\src\features\documents\components\DocumentPreview.tsx"
type nul > "apps\desktop\src\features\documents\hooks\useDocuments.ts"
type nul > "apps\desktop\src\features\documents\ipc\documentsIPC.ts"
type nul > "apps\desktop\src\features\documents\services\documentService.ts"
type nul > "apps\desktop\src\features\documents\store\documentStore.ts"

REM ============================================================
REM  DESKTOP - writer feature
REM ============================================================
type nul > "apps\desktop\src\features\writer\components\WriterProgress.tsx"
type nul > "apps\desktop\src\features\writer\components\PromptSelector.tsx"
type nul > "apps\desktop\src\features\writer\components\ArticlePreview.tsx"
type nul > "apps\desktop\src\features\writer\hooks\useWriter.ts"
type nul > "apps\desktop\src\features\writer\ipc\writerIPC.ts"
type nul > "apps\desktop\src\features\writer\services\writerService.ts"
type nul > "apps\desktop\src\features\writer\store\writerStore.ts"

REM ============================================================
REM  DESKTOP - validation feature
REM ============================================================
type nul > "apps\desktop\src\features\validation\components\ValidationReport.tsx"
type nul > "apps\desktop\src\features\validation\components\ReadabilityPanel.tsx"
type nul > "apps\desktop\src\features\validation\components\SeoPanel.tsx"
type nul > "apps\desktop\src\features\validation\components\OriginalityPanel.tsx"
type nul > "apps\desktop\src\features\validation\components\AiMarkersPanel.tsx"
type nul > "apps\desktop\src\features\validation\components\GrammarPanel.tsx"
type nul > "apps\desktop\src\features\validation\components\KeywordPanel.tsx"
type nul > "apps\desktop\src\features\validation\hooks\useValidation.ts"
type nul > "apps\desktop\src\features\validation\ipc\validationIPC.ts"
type nul > "apps\desktop\src\features\validation\services\validationService.ts"
type nul > "apps\desktop\src\features\validation\store\validationStore.ts"

REM ============================================================
REM  DESKTOP - export feature
REM ============================================================
type nul > "apps\desktop\src\features\export\components\ExportMenu.tsx"
type nul > "apps\desktop\src\features\export\hooks\useExport.ts"
type nul > "apps\desktop\src\features\export\ipc\exportIPC.ts"
type nul > "apps\desktop\src\features\export\services\exportService.ts"

REM ============================================================
REM  DESKTOP - settings feature
REM ============================================================
type nul > "apps\desktop\src\features\settings\hooks\useSettings.ts"
type nul > "apps\desktop\src\features\settings\ipc\settingsIPC.ts"
type nul > "apps\desktop\src\features\settings\pages\Settings.tsx"
type nul > "apps\desktop\src\features\settings\services\updateService.ts"
type nul > "apps\desktop\src\features\settings\store\settingsStore.ts"

REM ============================================================
REM  DESKTOP - admin feature
REM ============================================================
type nul > "apps\desktop\src\features\admin\components\UserForm.tsx"
type nul > "apps\desktop\src\features\admin\components\UserList.tsx"
type nul > "apps\desktop\src\features\admin\hooks\useAdmin.ts"
type nul > "apps\desktop\src\features\admin\ipc\adminIPC.ts"
type nul > "apps\desktop\src\features\admin\pages\Admin.tsx"
type nul > "apps\desktop\src\features\admin\store\adminStore.ts"

REM ============================================================
REM  DESKTOP - automation feature
REM ============================================================
type nul > "apps\desktop\src\features\automation\components\CaptchaModal.tsx"
type nul > "apps\desktop\src\features\automation\components\RunningTaskIndicator.tsx"
type nul > "apps\desktop\src\features\automation\hooks\useAutomation.ts"
type nul > "apps\desktop\src\features\automation\ipc\automationIPC.ts"
type nul > "apps\desktop\src\features\automation\store\automationStore.ts"

REM ============================================================
REM  DESKTOP - resources
REM ============================================================
type nul > "apps\desktop\src\resources\config\exclude_sites.csv"
type nul > "apps\desktop\src\resources\config\paywall_domains.txt"
type nul > "apps\desktop\src\resources\config\default_presets.json"
type nul > "apps\desktop\src\resources\images\logo.svg"

REM ============================================================
REM  PYTHON SCRIPTS
REM ============================================================
echo [PYTHON] Creating Python script files...

type nul > "apps\desktop\src\resources\scripts\core\__init__.py"
type nul > "apps\desktop\src\resources\scripts\core\control_mode.py"
type nul > "apps\desktop\src\resources\scripts\core\output.py"
type nul > "apps\desktop\src\resources\scripts\core\browser.py"
type nul > "apps\desktop\src\resources\scripts\core\extractor.py"
type nul > "apps\desktop\src\resources\scripts\core\file_io.py"
type nul > "apps\desktop\src\resources\scripts\core\utils.py"

type nul > "apps\desktop\src\resources\scripts\research\__init__.py"
type nul > "apps\desktop\src\resources\scripts\research\google_search.py"
type nul > "apps\desktop\src\resources\scripts\research\duckduckgo_search.py"
type nul > "apps\desktop\src\resources\scripts\research\extract_dispatch.py"
type nul > "apps\desktop\src\resources\scripts\research\extract_generic.py"
type nul > "apps\desktop\src\resources\scripts\research\extract_reddit.py"
type nul > "apps\desktop\src\resources\scripts\research\extract_quora.py"
type nul > "apps\desktop\src\resources\scripts\research\extract_medium.py"
type nul > "apps\desktop\src\resources\scripts\research\extract_twitter.py"

type nul > "apps\desktop\src\resources\scripts\writer\__init__.py"
type nul > "apps\desktop\src\resources\scripts\writer\deepseek_writer.py"

type nul > "apps\desktop\src\resources\scripts\validation\__init__.py"
type nul > "apps\desktop\src\resources\scripts\validation\readability.py"
type nul > "apps\desktop\src\resources\scripts\validation\seo_check.py"
type nul > "apps\desktop\src\resources\scripts\validation\keyword_check.py"
type nul > "apps\desktop\src\resources\scripts\validation\originality.py"
type nul > "apps\desktop\src\resources\scripts\validation\ai_markers.py"
type nul > "apps\desktop\src\resources\scripts\validation\grammar.py"
type nul > "apps\desktop\src\resources\scripts\validation\validate_all.py"

type nul > "apps\desktop\src\resources\scripts\export\__init__.py"
type nul > "apps\desktop\src\resources\scripts\export\export_docx.py"
type nul > "apps\desktop\src\resources\scripts\export\export_md.py"

type nul > "apps\desktop\src\resources\scripts\prompts\default.md"
type nul > "apps\desktop\src\resources\scripts\prompts\seo-focused.md"
type nul > "apps\desktop\src\resources\scripts\prompts\conversational.md"

type nul > "apps\desktop\src\resources\scripts\migrations\.gitkeep"
type nul > "apps\desktop\src\resources\scripts\main.py"
type nul > "apps\desktop\src\resources\scripts\requirements.txt"
type nul > "apps\desktop\src\resources\scripts\README.md"

echo.
echo ============================================================
echo  WriteSpeare structure created successfully!
echo ============================================================
echo.
echo Next steps:
echo   1. Fill in package.json files (root, server, desktop).
echo   2. Run npm install commands.
echo   3. Set up embedded Python runtime.
echo   4. Begin coding (Session 1 = backend foundation).
echo.
pause