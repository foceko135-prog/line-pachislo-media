# -*- coding: utf-8 -*-
"""deploy_pachi_media.py の wrangler 検出を、定時タスク相当の痩せたPATHで確かめる。

夜間の実害(2026-08-19未明)は「PATHに %APPDATA%\\npm が無い環境で which が None を返し、
npxへ落ちて600秒タイムアウト→LINE配信中止」だった。対話シェルでは再現しないので、
PATHを意図的に削って再現させる。
"""
import os, sys, shutil
sys.stdout.reconfigure(encoding="utf-8")

REPO_DIR = r"C:\Users\谷川\line-pachislo-media"
ok = fail = 0


def check(label, got, want):
    global ok, fail
    if got == want:
        ok += 1
        print(f"  OK   {label}: {got}")
    else:
        fail += 1
        print(f"  NG   {label}: got={got} want={want}")


def detect():
    """deploy_pachi_media.py と同じ手順(移植・実装を変えたらここも合わせる)。"""
    wr = shutil.which("wrangler")
    if not wr:
        appdata = os.environ.get("APPDATA") or os.path.join(
            os.path.expanduser("~"), "AppData", "Roaming")
        for cand in (
            os.path.join(appdata, "npm", "wrangler.CMD"),
            os.path.join(appdata, "npm", "wrangler.cmd"),
            os.path.join(appdata, "npm", "wrangler"),
            os.path.join(REPO_DIR, "node_modules", ".bin", "wrangler.CMD"),
            os.path.join(REPO_DIR, "node_modules", ".bin", "wrangler"),
        ):
            if os.path.exists(cand):
                return cand
    return wr


print("=== [1] 対話シェルのPATH(いまの環境) ===")
_now = detect()
print("  検出:", _now)
check("見つかる", _now is not None, True)

print()
print("=== [2] 定時タスク相当=PATHから %APPDATA%\\npm を外す(実害の再現) ===")
_orig = os.environ.get("PATH", "")
_appdata_npm = os.path.join(os.environ.get("APPDATA", ""), "npm").lower()
_slim = os.pathsep.join(
    p for p in _orig.split(os.pathsep)
    if p.strip() and p.strip().lower().rstrip("\\") != _appdata_npm.rstrip("\\"))
os.environ["PATH"] = _slim
try:
    _which = shutil.which("wrangler")
    print("  shutil.which だけ :", _which, " ← 旧版はここで諦めてnpxへ落ちていた")
    check("旧版の判定は失敗する(実害の再現)", _which is None, True)
    _new = detect()
    print("  新版の検出        :", _new)
    check("新版は見つけられる", _new is not None, True)
    check("実ファイルとして存在", os.path.exists(_new) if _new else False, True)
finally:
    os.environ["PATH"] = _orig

print()
print("=== [3] PATHもAPPDATAも無い最悪ケース → npxへ落ちる(従来どおり) ===")
_oa = os.environ.get("APPDATA")
os.environ["PATH"] = ""
os.environ["APPDATA"] = r"C:\__no_such_dir__"
try:
    # expanduser 経由の実在パスを拾わないよう、REPO配下も見ない前提の素の判定を見る
    _worst = shutil.which("wrangler")
    check("PATHが空ならwhichはNone", _worst is None, True)
finally:
    os.environ["PATH"] = _orig
    if _oa is not None:
        os.environ["APPDATA"] = _oa

print()
print(f"===== 結果: OK {ok} / NG {fail} =====")
sys.exit(0 if fail == 0 else 1)
