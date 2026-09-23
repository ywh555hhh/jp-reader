#!/usr/bin/env bash
#
# 单次改动的规模预算。
#
# 为什么需要它：屎山几乎都来自"一次大改"。而一个 2000 行的 diff 实际上没有被评审，
# 只是被点了同意。这个检查把"要么拆开，要么写清理由"变成一次机械判定。
#
# 本地用法：
#   BASE_SHA=origin/master HEAD_SHA=HEAD PR_BODY="$(cat /tmp/body.md)" bash scripts/pr-budget.sh
# CI 用法：见 .github/workflows/gate.yml 的 pr-budget job。
set -uo pipefail

MAX_FILES="${PR_BUDGET_MAX_FILES:-15}"
MAX_LINES="${PR_BUDGET_MAX_LINES:-800}"

base="${BASE_SHA:-}"
head="${HEAD_SHA:-}"

if [ -z "$base" ] || [ -z "$head" ]; then
  echo "pr-budget: 缺少 BASE_SHA / HEAD_SHA，跳过（非 PR 场景）"
  exit 0
fi

if ! git cat-file -e "$base^{commit}" 2>/dev/null || ! git cat-file -e "$head^{commit}" 2>/dev/null; then
  echo "pr-budget: 本地缺少 $base 或 $head（浅克隆），跳过"
  exit 0
fi

stats="$(git diff --numstat "$base" "$head" | awk '{added += $1; removed += $2; files += 1} END {print added+0, removed+0, files+0}')"
set -- $stats
added="$1"
removed="$2"
files="$3"
total=$((added + removed))

echo "pr-budget: 文件 $files / 新增 $added / 删除 $removed / 合计 $total 行"
echo "pr-budget: 上限 文件 $MAX_FILES / 合计 $MAX_LINES 行"

if [ "$files" -le "$MAX_FILES" ] && [ "$total" -le "$MAX_LINES" ]; then
  echo "pr-budget: 通过"
  exit 0
fi

# 豁免通道：必须在 PR 描述里写明理由，理由会留在评审记录里。
#
# 优先从 GitHub 事件 JSON 读 PR 描述，而不是从环境变量传：
# 带换行的 env 会被 Actions 整段打进日志（踩过一次），日志里塞一份 PR 描述既吵又没用。
body="${PR_BODY:-}"
if [ -z "$body" ] && [ -n "${GITHUB_EVENT_PATH:-}" ] && [ -f "${GITHUB_EVENT_PATH:-}" ] && command -v jq >/dev/null 2>&1; then
  body="$(jq -r '.pull_request.body // ""' "$GITHUB_EVENT_PATH" 2>/dev/null || true)"
fi

if printf '%s' "$body" | grep -qiE 'budget-exempt:[[:space:]]*[^[:space:]]'; then
  echo "pr-budget: 超出预算，但 PR 描述里声明了 budget-exempt 理由，放行"
  exit 0
fi

echo ""
echo "pr-budget: 超出预算。"
echo "一个不可评审的 diff 等于没有被评审，请拆成可独立评审的多个 PR。"
echo "如果确实是机械性的大范围改动（批量重命名、格式化、生成文件），"
echo "在 PR 描述里加一行："
echo "    budget-exempt: <为什么无法拆分>"
exit 1
