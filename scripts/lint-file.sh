#!/usr/bin/env bash
#
# 只检查指定的文件，给编辑期用（比 npm run gate 快一个数量级）。
#
#   npm run lint:file -- vscode-extension/src/readingView.ts
#   npm run lint:file            # 不带参数时检查 git 暂存区里的 ts/js
#
# 它和 npm run gate 共用同一套规则（sgconfig.yml / .dependency-cruiser.cjs），
# 只是把检查范围缩小到这几个文件——规则本身不会因为"跑得快"而变松。
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

files=("$@")

if [ "${#files[@]}" -eq 0 ]; then
  while IFS= read -r f; do
    [ -n "$f" ] && files+=("$f")
  done < <(git diff --cached --name-only --diff-filter=ACM 2>/dev/null | grep -E '\.(ts|js|mjs)$' || true)
fi

if [ "${#files[@]}" -eq 0 ]; then
  echo "没有需要检查的文件。"
  exit 0
fi

ts_files=()
for f in "${files[@]}"; do
  case "$f" in
    *.ts) [ -f "$f" ] && ts_files+=("$f") ;;
  esac
done

echo "检查 ${#files[@]} 个文件：${files[*]}"
status=0

if [ "${#ts_files[@]}" -gt 0 ]; then
  echo ""
  echo "── ast-grep（架构否命题）"
  if [ -x node_modules/.bin/ast-grep ]; then
    node_modules/.bin/ast-grep scan "${ts_files[@]}" || status=1
  else
    echo "SKIP 未安装 @ast-grep/cli（仓库根目录 npm install）"
  fi

  echo ""
  echo "── dependency-cruiser（依赖图）"
  if [ -x node_modules/.bin/depcruise ]; then
    node_modules/.bin/depcruise "${ts_files[@]}" --output-type err-long || status=1
  else
    echo "SKIP 未安装 dependency-cruiser（仓库根目录 npm install）"
  fi
fi

if [ "$status" -ne 0 ]; then
  echo ""
  echo "命中架构约束。每条规则的 note 里有「为什么」和「正确写法」。"
fi
exit "$status"
