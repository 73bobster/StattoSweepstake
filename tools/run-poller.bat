@echo off
REM Double-click to start the live-match poller. Turn your VPN off first. Leave the window open.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-poller.ps1"
