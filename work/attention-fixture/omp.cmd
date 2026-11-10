@echo off
rem Fake OMP for the attention fixture: ignores "acp" and runs the combined fake agent (no model calls).
python "%~dp0..\combined-fixture\agent.py"
