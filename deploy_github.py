import subprocess
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

GH_EXE = r"C:\Program Files\GitHub CLI\gh.exe"
REPO_DIR = r"C:\Users\slkam\Documents\cad-map-navigator"

def safe_print(s):
    if not s:
        return
    clean = s.encode("ascii", errors="replace").decode("ascii")
    print(clean, flush=True)

def run(cmd, cwd=REPO_DIR):
    safe_print(f">>> {' '.join(cmd) if isinstance(cmd, list) else cmd}")
    res = subprocess.run(
        cmd,
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace"
    )
    if res.stdout:
        safe_print(res.stdout.strip())
    if res.stderr:
        safe_print(res.stderr.strip())
    return res

def main():
    os.chdir(REPO_DIR)
    run(["git", "config", "--global", "--add", "safe.directory", "C:/Users/slkam/Documents/cad-map-navigator"])

    # 1. Check auth status
    run([GH_EXE, "auth", "status"])

    # 2. Ensure git repo is clean & committed
    run(["git", "add", "-A"])
    run(["git", "commit", "-m", "Deploy integrated CAD Map Navigator"])

    for repo_name in ["cad-map-navigator", "cad-map-viewer"]:
        full_repo = f"slkamg0-ai/{repo_name}"
        safe_print(f"\n=== Deploying to GitHub: {full_repo} ===")

        # Check if repo exists
        check_res = run([GH_EXE, "repo", "view", full_repo, "--json", "name,url"])
        if check_res.returncode != 0:
            # Create public repo
            run([GH_EXE, "repo", "create", full_repo, "--public", "--description", "CAD Map Navigator - Field Map GPS & CAD Viewer"])

        # Push using git
        remote_url = f"https://github.com/{full_repo}.git"
        run(["git", "push", "--force", remote_url, "main:main"])

        # Enable GitHub Pages on main branch / root
        run([
            GH_EXE, "api",
            "-X", "POST",
            f"repos/{full_repo}/pages",
            "-f", "source[branch]=main",
            "-f", "source[path]=/"
        ])

        # Also update GitHub Pages if already enabled
        run([
            GH_EXE, "api",
            "-X", "PUT",
            f"repos/{full_repo}/pages",
            "-f", "source[branch]=main",
            "-f", "source[path]=/"
        ])

        safe_print(f"LIVE URL: https://slkamg0-ai.github.io/{repo_name}/")

if __name__ == "__main__":
    main()
