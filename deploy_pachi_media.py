# -*- coding: utf-8 -*-
"""line-pachislo-mediaリポジトリの手動デプロイ用ワンコマンド(2026-07-30新設)。

背景: このリポジトリの本番URL(https://pachi-media.pages.dev)は、GitHubへの
git pushだけでは一切更新されない(Cloudflare Pages側でGitHub連携=オートビルドを
使っていないため)。夜間の自動配信(push_line_atsuta.py)は「git push→wrangler pages
deploy」の2段階を毎回セットで実行しているので問題にならないが、日中に個別ファイルだけ
手動でgit pushして済ませると、wrangler deployを忘れて「pushしたのに反映されない」
事故になる(2026-07-30夜、シマヒートの罫線修正で実際に発生し谷川氏へ説明する事態に
なった。詳細はmemory shimazu-heat-last7-tap-html参照)。

このスクリプトはgit add/commit/push + wrangler pages deployを1コマンドにまとめ、
「デプロイ手順を忘れる」という失敗モードを構造的に無くす(恒久対策)。

usage: python deploy_pachi_media.py ["コミットメッセージ"]
  コミットメッセージ省略時は "manual deploy <日時>" を使う。
  変更が無ければcommit/pushはスキップしwrangler deployだけ実行する
  (直前のpushでdeployし忘れていた場合の再実行にも使えるように)。
"""
import subprocess, sys, datetime, os, shutil

# wrangler出力の絵文字(⛅等)がcp932コンソールでUnicodeEncodeErrorになるためUTF-8化
# (push_line_atsuta.pyと同じ対策・2026-07-30)。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

REPO_DIR = r"C:\Users\谷川\line-pachislo-media"
CF_TOKEN_FILE = r"C:\Users\谷川\.claude\tools\line_opechat_watch\cloudflare_api_token.txt"
CF_ACCOUNT_ID = "72f62d3b944792a6f49ad0accc738d14"
CF_PROJECT = "pachi-media"

log = lambda *a: print("[deploy-pachi-media]", *a, flush=True)


def run(cmd, **kw):
    r = subprocess.run(cmd, cwd=REPO_DIR, capture_output=True, text=True,
                        encoding="utf-8", errors="replace", **kw)
    return r


def main():
    msg = sys.argv[1] if len(sys.argv) > 1 else f"manual deploy {datetime.datetime.now():%Y-%m-%d %H:%M}"

    st = run(["git", "status", "--porcelain"])
    if st.stdout.strip():
        log("変更あり。add/commit/pushします")
        run(["git", "add", "-A"])
        r = run(["git", "commit", "-m", msg])
        log("git commit", (r.stdout or r.stderr or "").strip()[-200:])
        r = run(["git", "push", "origin", "HEAD"])
        if r.returncode != 0:
            log("git push失敗", (r.stderr or "").strip()[-300:])
            sys.exit(1)
        log("git push OK")
    else:
        log("差分無し。commit/pushはスキップしdeployのみ実行します")

    if not os.path.exists(CF_TOKEN_FILE):
        log("CF_TOKEN_FILEが見つかりません。デプロイ中止:", CF_TOKEN_FILE)
        sys.exit(1)
    cf_token = open(CF_TOKEN_FILE, encoding="utf-8").read().strip()
    env = dict(os.environ, CLOUDFLARE_API_TOKEN=cf_token, CLOUDFLARE_ACCOUNT_ID=CF_ACCOUNT_ID)
    # 2026-08-11: npxはキャッシュにwranglerが無いと毎回レジストリから取りに行き、
    # 600秒のタイムアウトに掛かる(8/11未明に夜間LINE配信がこれで丸ごと中止された)。
    # グローバル導入済み(npm install -g wrangler)のwranglerを直接叩き、
    # 見つからない環境だけ従来のnpxへフォールバックする。
    #
    # ★2026-08-19: PATHだけに頼るのをやめた(谷川氏指示「関門で止まった原因究明対策」)。
    #   wranglerは入っている(4.120.1)のに、定時タスクの実行環境ではPATHに
    #   %APPDATA%\npm が載らないため shutil.which("wrangler") が None を返し、
    #   毎回npxへ落ちて600秒タイムアウト→Cloudflare配信失敗→LINE配信が中止されていた。
    #   実害: 2026-08-19未明。素材もgit pushも通ったのに最後のdeployだけで倒れ、
    #   memory line-url-must-be-pachi-media の規定どおりLINEを送らずに終わった。
    #   ★対話シェルではPATHに載るので手で試すと再現しない=気付きにくい類の故障。
    #   → PATHで見つからなければ既定の導入先を実ファイルとして探す。
    _wr = shutil.which("wrangler")
    if not _wr:
        _appdata = os.environ.get("APPDATA") or os.path.join(
            os.path.expanduser("~"), "AppData", "Roaming")
        for _cand in (
            os.path.join(_appdata, "npm", "wrangler.CMD"),
            os.path.join(_appdata, "npm", "wrangler.cmd"),
            os.path.join(_appdata, "npm", "wrangler"),
            os.path.join(REPO_DIR, "node_modules", ".bin", "wrangler.CMD"),
            os.path.join(REPO_DIR, "node_modules", ".bin", "wrangler"),
        ):
            if os.path.exists(_cand):
                _wr = _cand
                log("wranglerをPATH外の既定の場所で発見:", _wr)
                break
    _cmd = (f'"{_wr}"' if _wr else "npx wrangler") + \
        f' pages deploy . --project-name {CF_PROJECT} --branch main --commit-dirty=true'
    if not _wr:
        log("⚠️ wrangler未検出(PATHにも既定の場所にも無い)→npxへフォールバック。"
            "600秒で落ちる可能性が高い。npm install -g wrangler を確認すること")
    r = subprocess.run(
        _cmd,
        cwd=REPO_DIR, shell=True, env=env, capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=600)
    print(r.stdout)
    if r.returncode != 0:
        log("wrangler deploy失敗", (r.stderr or "").strip()[-300:])
        sys.exit(1)
    log("wrangler deploy OK。本番URL: https://pachi-media.pages.dev")


if __name__ == "__main__":
    main()
