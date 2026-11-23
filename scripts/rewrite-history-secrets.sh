#!/usr/bin/env bash
# scripts/rewrite-history-secrets.sh —— 历史重写草案（2026-11-23）
#
# !!! 危险：会改写全部提交哈希，所有克隆/分支/PR 都会失配。默认拒绝执行。!!!
# 本文件只是草案：本次任务没有运行它，也没有跑 filter-repo。
#
# 前置条件（缺一不可）：
#   1) 已到智增增 / SiliconFlow 平台吊销或轮换两枚 key（重写历史不能替代吊销）
#   2) 所有协作者停止推送，并知悉旧克隆作废
#   3) 已安装 git-filter-repo（pip install git-filter-repo）
#   4) 先把「脱敏 + untrack」这次改动 commit 掉（filter-repo 要求工作树干净）
#   5) 磁盘留出 ≥2 倍仓库体积；确认备份目录可写
#
# 用法（在 Git Bash 里）：
#   CONFIRM_REWRITE=YES-DESTROY-HISTORY \
#   LEAKED_ZHIZENGZENG_KEY='<旧 key>' LEAKED_SILICONFLOW_KEY='<旧 key>' \
#   bash scripts/rewrite-history-secrets.sh
#
# 密钥只从环境变量读取，绝不写进脚本/仓库；临时替换文件 600 权限，退出即删。

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/_incoming/my-neuro"
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/../history-backup-$TS}"
TMP_REPL=""

die() { echo "ERROR: $*" >&2; exit 1; }
cleanup() { [ -n "$TMP_REPL" ] && rm -f "$TMP_REPL"; }
trap cleanup EXIT

[ "${CONFIRM_REWRITE:-}" = "YES-DESTROY-HISTORY" ] || die "未确认。设置 CONFIRM_REWRITE=YES-DESTROY-HISTORY 后才可运行。"
[ -n "${LEAKED_ZHIZENGZENG_KEY:-}" ] || die "缺少 LEAKED_ZHIZENGZENG_KEY（从平台复制旧 key，仅经环境变量传入）"
[ -n "${LEAKED_SILICONFLOW_KEY:-}" ] || die "缺少 LEAKED_SILICONFLOW_KEY（从平台复制旧 key，仅经环境变量传入）"
command -v git-filter-repo >/dev/null 2>&1 || die "未安装 git-filter-repo（pip install git-filter-repo）"
[ -d "$APP/.git" ] || die "找不到 app 仓：$APP"

for repo in "$APP" "$ROOT"; do
  [ -z "$(git -C "$repo" status --porcelain --untracked-files=no)" ] || die "$repo 有未提交的跟踪改动：先 commit 或 stash 再重写（未跟踪文件请另行备份）"
done

# ── 备份：镜像 clone + bundle，任一可恢复 ─────────────────────────────
mkdir -p "$BACKUP_DIR"
echo "[备份] $BACKUP_DIR"
git clone --mirror "$APP" "$BACKUP_DIR/my-neuro.git"
git clone --mirror "$ROOT" "$BACKUP_DIR/main.git"
git -C "$APP" bundle create "$BACKUP_DIR/my-neuro.bundle" --all
git -C "$ROOT" bundle create "$BACKUP_DIR/main.bundle" --all

# ── 替换表：旧 key => 占位符（不回显、不落仓库）──────────────────────
TMP_REPL="$(mktemp)"
chmod 600 "$TMP_REPL"
printf '%s==>REDACTED_ZHIZENGZENG_KEY\n' "$LEAKED_ZHIZENGZENG_KEY" >> "$TMP_REPL"
printf '%s==>REDACTED_SILICONFLOW_KEY\n' "$LEAKED_SILICONFLOW_KEY" >> "$TMP_REPL"

# ── ① app 仓：把两枚 key 从所有历史里替换掉 ─────────────────────────
echo "[1/2] 重写 app 仓历史（replace-text）"
git -C "$APP" filter-repo --force --replace-text "$TMP_REPL"

# ── ② 主仓：彻底移除恢复记忆 / 运行日志 / 音频样本 ─────────────────
echo "[2/2] 重写主仓历史（invert-paths）"
git -C "$ROOT" filter-repo --force --invert-paths \
  --path '_probe/recovery' \
  --path-glob 'pet-runtime/.state/*.out' \
  --path-glob 'pet-runtime/.state/*.err' \
  --path-glob 'pet-runtime/.state/*.log*' \
  --path-glob 'pet-runtime/.state/_*.wav' \
  --path-glob 'pet-runtime/.state/_*.mp3'

# filter-repo 默认会删掉 origin；推送前先重加（地址按实际填）
# git -C "$APP" remote add origin <my-neuro 原地址>
# git -C "$ROOT" remote add origin <主仓原地址>

# 复查：应无输出（若有输出，说明仍有残留，先别推送）
# git -C "$APP" log -p --all -S 'sk-zk' | grep -E 'sk-zk[0-9a-f]{20,}' || true
# git -C "$APP" log -p --all -S 'sk-yg' | grep -E 'sk-yg[a-z]{20,}' || true
# git -C "$ROOT" log --all --oneline -- '_probe/recovery' 'pet-runtime/.state/*.out' || true

cat <<WARN

======================= force-push 警告（必读） =======================
1. 重写后所有提交哈希都变了。每个分支都要强推：
     git push --force --all && git push --force --tags
2. 所有旧克隆必须重新 clone；旧克隆再推一次就会把明文历史带回来。
3. GitHub/GitLab 的 PR/MR 引用、fork、缓存对象可能仍保留旧 blob；
   需要联系平台清缓存，或删除仓库重建后再上传。
4. 强推前再确认一次：两枚 key 已在平台吊销/轮换，且用量已核对。
5. 备份在：${BACKUP_DIR}
   恢复：git clone <备份>/main.git 或 git clone <备份>/main.bundle
6. filter-repo 会移除 origin，推送前记得重加 remote。
=======================================================================
WARN
