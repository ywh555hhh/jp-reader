#!/usr/bin/env bash
#
# 装上本地 git hook，让"提交前"就跑一遍 gate。
#
#   npm run setup
#
# 为什么不引 husky/lefthook：这个仓库只有一条 gate 命令，
# 多一个依赖就多一个 agent 需要先理解的东西。原生 hook 够用且没有黑盒。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

HOOK_DIR="$(git rev-parse --git-path hooks)"
mkdir -p "$HOOK_DIR"

cat > "$HOOK_DIR/pre-commit" <<'HOOK'
#!/usr/bin/env bash
# 由 scripts/install-hooks.sh 生成。不要手改这个文件——改 scripts/gate.sh。
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

if [ ! -d node_modules ]; then
  echo "pre-commit: 仓库根目录没有 node_modules，跳过 gate（请先 npm install）"
  exit 0
fi

echo "pre-commit: 运行 npm run gate（想跳过：git commit --no-verify，但请说明理由）"
if ! npm run --silent gate; then
  echo ""
  echo "gate 未通过，提交被拦下。改完再提交。"
  exit 1
fi
HOOK

chmod +x "$HOOK_DIR/pre-commit"
echo "已安装 $HOOK_DIR/pre-commit"

cat > "$HOOK_DIR/pre-push" <<'HOOK'
#!/usr/bin/env bash
# 由 scripts/install-hooks.sh 生成。
# pre-commit 可以被 --no-verify 跳过，pre-push 再拦一道：
# 推出去之前必须 gate 绿，否则 CI 会红，而"红了以后再说"的债务从来没人还。
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

if [ ! -d node_modules ]; then
  echo "pre-push: 仓库根目录没有 node_modules，跳过 gate（请先 npm install）"
  exit 0
fi

echo "pre-push: 运行 npm run gate"
if ! npm run --silent gate; then
  echo ""
  echo "gate 未通过，推送被拦下。"
  exit 1
fi
HOOK

chmod +x "$HOOK_DIR/pre-push"
echo "已安装 $HOOK_DIR/pre-push"

cat > "$HOOK_DIR/commit-msg" <<'HOOK'
#!/usr/bin/env bash
# 由 scripts/install-hooks.sh 生成。
# 禁止"抑制类"提交信息把问题糊过去，也禁止空提交信息。
set -uo pipefail
msg_file="$1"
msg="$(head -1 "$msg_file")"

case "$msg" in
  wip|WIP|fix|fixup|temp|tmp|asdf|test)
    echo "commit-msg: 提交信息太模糊（\"$msg\"）。写清楚改了什么、为什么。"
    exit 1
    ;;
esac

if [ "${#msg}" -lt 8 ]; then
  echo "commit-msg: 第一行至少 8 个字符，说明「改了什么」。"
  exit 1
fi
HOOK

chmod +x "$HOOK_DIR/commit-msg"
echo "已安装 $HOOK_DIR/commit-msg"
echo ""
echo "完成后跑一次：npm run gate"
echo ""
echo "注意：这个仓库是私有 + 免费账号，GitHub 的分支保护 / ruleset 不可用，"
echo "所以这三个 hook 是主要拦截手段。请不要用 --no-verify 绕过它们。"
