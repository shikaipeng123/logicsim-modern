#!/usr/bin/env bash
# ==========================================================================
# 拉取前端运行时依赖到 public/lib
#
# 为什么依赖不进仓库：
#   第三方库合计约 1.3MB，没必要塞进源码仓库。本地开发跑一次本脚本即可；
#   线上由 .github/workflows/pages.yml 在部署前拉取，并固化回仓库，
#   所以仓库在第一次部署之后也是自包含的。
#
# 版本策略（必须与改造时验证过的版本一致）：
#   JointJS 3.3.1     —— 用官方 npm 发行版（含完整 highlighters / elementTools）
#   jQuery 3.4.1 / lodash 4.17.14 / Backbone 1.4.0
#   graphlib 2.1.8 / dagre 0.8.5      —— 取自上游项目，保证与改造基线同源
#
# 用法：
#   bash scripts/vendor-deps.sh [目标目录，默认 public/lib]
#
# 可用环境变量覆盖下载地址（内网镜像等）：
#   JOINTJS_BASE / LIBS_BASE
# ==========================================================================
set -euo pipefail

DEST="${1:-public/lib}"

JOINTJS_BASE="${JOINTJS_BASE:-https://cdnjs.cloudflare.com/ajax/libs/jointjs/3.3.1}"
LIBS_BASE="${LIBS_BASE:-https://gitlab.com/kuangdash/logicsim/-/raw/main/public/lib}"

# 每行：<本地文件名>|<主地址>|<兜底地址（可为空）>
MANIFEST=(
  "jquery.min.js|$LIBS_BASE/jquery.min.js|https://cdnjs.cloudflare.com/ajax/libs/jquery/3.4.1/jquery.min.js"
  "lodash.min.js|$LIBS_BASE/lodash.min.js|https://cdnjs.cloudflare.com/ajax/libs/lodash.js/4.17.14/lodash.min.js"
  "backbone.js|$LIBS_BASE/backbone.js|https://cdnjs.cloudflare.com/ajax/libs/backbone.js/1.4.0/backbone.js"
  "graphlib.min.js|$LIBS_BASE/graphlib.min.js|https://cdn.jsdelivr.net/npm/graphlib@2.1.8/dist/graphlib.min.js"
  "dagre.min.js|$LIBS_BASE/dagre.min.js|https://cdn.jsdelivr.net/npm/dagre@0.8.5/dist/dagre.min.js"
  "joint.min.js|$JOINTJS_BASE/joint.min.js|https://unpkg.com/jointjs@3.3.1/dist/joint.min.js"
  "joint.css|$JOINTJS_BASE/joint.css|https://unpkg.com/jointjs@3.3.1/dist/joint.css"
)

mkdir -p "$DEST"

try_download() {
  curl -fsSL --retry 3 --retry-delay 2 --max-time 150 -o "$2" "$1" 2>/dev/null
}

fail=0
for entry in "${MANIFEST[@]}"; do
  name="${entry%%|*}"
  rest="${entry#*|}"
  primary="${rest%%|*}"
  mirror="${rest#*|}"
  target="$DEST/$name"

  if [ -s "$target" ]; then
    printf '  = %-18s 已存在（%s 字节），跳过\n' "$name" "$(wc -c < "$target" | tr -d ' ')"
    continue
  fi

  if try_download "$primary" "$target"; then
    printf '  v %-18s %8s 字节  主源\n' "$name" "$(wc -c < "$target" | tr -d ' ')"
    continue
  fi
  rm -f "$target"

  if [ -n "$mirror" ] && try_download "$mirror" "$target"; then
    printf '  v %-18s %8s 字节  兜底源\n' "$name" "$(wc -c < "$target" | tr -d ' ')"
    continue
  fi
  rm -f "$target"

  printf '  x %-18s 下载失败\n' "$name" >&2
  fail=1
done

if [ "$fail" -ne 0 ]; then
  cat >&2 <<'MSG'

有依赖没能拉取成功。可以：
  1. 检查网络后重试；
  2. 用 JOINTJS_BASE / LIBS_BASE 指定可达的镜像地址；
  3. 或者手动把缺的文件放进目标目录后重新执行（已存在的文件会跳过）。
MSG
  exit 1
fi

echo ""
echo "依赖就绪：$DEST"
