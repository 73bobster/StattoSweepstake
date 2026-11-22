@echo off
REM Double-click to pull everything API-Football has on one player. Turn your VPN off first.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-player-report.ps1"
