#!/usr/bin/env bash
#
# JP Reader 的唯一 gate。CI 跑的就是这一条命令，本地必须跑同一条。
#
#   npm run gate              # 完整检查
#   npm run lint:file -- <f>  # 只查改动的文件（编辑期用）
#   npm run setup             # 装上 pre-commit hook，让提交前自动跑 gate
#
# 为什么单独包一层：CI 和本地如果跑的不是同一条命令，就会出现
# "本地过了、CI 挂了"的来回，agent 会在这种来回里烧掉大量预算。
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

names=()
statuses=()

step() {
  local name="$1"
  shift
  echo ""
  echo "── ${name} ──────────────────────────────────────────"
  if "$@"; then
    statuses+=("PASS")
  else
    statuses+=("FAIL")
  fi
  names+=("${name}")
}

echo "JP Reader gate  ($(date -u '+%Y-%m-%dT%H:%M:%SZ'))"

step "1/4 护栏配置完整性" node scripts/guard-rules.mjs
step "2/4 架构指标棘轮" node scripts/ratchet.mjs
step "3/4 语义否命题测试" node --test tests/architecture.test.mjs
step "4/4 运行期否命题测试" npm run --silent test:unit

echo ""
echo "════════════════ gate 结果 ════════════════"
failed=0
for i in "${!names[@]}"; do
  printf '%-26s %s\n' "${names[$i]}" "${statuses[$i]}"
  if [ "${statuses[$i]}" != "PASS" ]; then
    failed=1
  fi
done

if [ "$failed" -ne 0 ]; then
  echo ""
  echo "结果：失败。上面的报错就是待办清单——按顺序修，不要绕过。"
  echo "如果确实是「约束本身需要变」，走 docs/adr/ 写一条 ADR，再调 baseline。"
  exit 1
fi

echo ""
echo "结果：全部通过"
