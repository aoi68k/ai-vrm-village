@echo off
chcp 65001 > NUL
title Voxel Game & GOAP NPC Environment Setup

echo ===================================================
echo   ボクセル箱庭ゲーム 環境自動構築スクリプト (setup.bat)
echo ===================================================
echo.

:: 1. Node.js のチェック
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js がインストールされていません。
    echo https://nodejs.org/ から LTS 版をダウンロードしてインストールしてください。
    echo.
    pause
    exit /b 1
)

echo [1/3] Node.js 検出成功:
node -v
echo.

:: 2. npm パッケージのインストール
echo [2/3] 依存ライブラリ (Three.js, Colyseus, TypeScript, Vite) をインストール中...
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] npm install に失敗しました。ネットワーク接続を確認してください。
    pause
    exit /b 1
)
echo.

:: 3. 完了案内
echo [3/3] 環境構築が正常に完了しました！
echo ===================================================
echo   【起動手順】
echo   1. 別ウィンドウでゲームサーバー（Colyseus）を起動:
echo      npm run dev:server
echo.
echo   2. このウィンドウでクライアント（Three.js / Vite）を起動:
echo      npm run dev:client
echo.
echo   3. 表示された URL (例: http://localhost:5173) をブラウザで開きます。
echo ===================================================
echo.
pause
