# Vercel Deploy Helper Script
Set-Location -Path $PSScriptRoot
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "  CAD Map Navigator - Vercel 배포 시작" -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "잠시 후 Vercel 질문이 나오면 아래와 같이 입력해주세요:"
Write-Host "  1. Set up and deploy? [Y/n]  : y 입력 후 엔터"
Write-Host "  2. Which scope?               : 그냥 엔터"
Write-Host "  3. Link to existing project?  : y 입력 후 엔터"
Write-Host "  4. What is the name?          : cad-map-viewer 입력 후 엔터"
Write-Host ""
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""

npx vercel --prod

Write-Host ""
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "배포 작업이 완료되었습니다!" -ForegroundColor Green
Read-Host "종료하려면 아무 키나 누르세요"
