@echo off
title Vercel Deploy - CAD Map Navigator
cd /d C:\Users\slkam\Documents\cad-map-navigator
echo ========================================================
echo   Step 1: Checking Vercel Login...
echo ========================================================
call npx vercel whoami >nul 2>&1
if %errorlevel% neq 0 (
    echo Please log in to Vercel in the browser window that opens...
    call npx vercel login
)
echo.
echo ========================================================
echo   Step 2: Deploying to https://cad-map-viewer.vercel.app
echo ========================================================
call npx vercel --prod --yes
echo.
echo ========================================================
echo   Deployment Complete!
echo   Open: https://cad-map-viewer.vercel.app
echo ========================================================
pause
