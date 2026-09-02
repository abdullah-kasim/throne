# agent-launcher-lib.sh — shared helpers for the throne's claudey/codexy yolo
# launchers. Sourced by the entry scripts that sit next to it, after their bash
# version guard has run; not meant to be executed directly.
#
# Needs bash >= 4.3 (namerefs) — see launcher-bash-guard.sh.
# shellcheck shell=bash
# shellcheck disable=SC2034
# ^ every `local -n *_ref` nameref below writes through to the caller's variable
# (the whole point of the pattern — see the codexy circular-nameref note further
# down); shellcheck 0.11 doesn't track that write-through as a use and flags each
# one as an unused assignment. False positive for the whole file, not a real one.

# Highest-priority PATH dir where enable-yolo-mode drops the claude/codex
# shims. Overridable (mainly for tests).
YOLO_OVERRIDE_DIR="${YOLO_OVERRIDE_DIR:-$HOME/bin-override}"

# 8-char hash of a path. Linux has md5sum; macOS ships `md5`.
# NOTE: hashes with printf (no trailing newline) on both platforms. The
# pre-2026-07 macOS bashrc hashed with `echo` (trailing newline), so mac
# backup dirs created before the port won't line up with new ones.
yolo_path_hash() {
    if command -v md5sum >/dev/null 2>&1; then
        printf "%s" "$1" | md5sum | cut -c1-8
    else
        printf "%s" "$1" | md5 | cut -c1-8
    fi
}

# True when running $1 would send the launcher back into itself: either it IS
# this wrapper, or it sits in the yolo override dir where enable-yolo-mode
# plants the shims. `-ef` compares device and inode THROUGH symlinks, so this
# needs no `readlink -f` (which stock macOS does not have); the literal path
# comparison additionally covers an override dir that does not exist yet.
yolo_path_recurses_into_wrapper() {
    local candidate="$1"
    local self_path="$2"

    [[ "$candidate" -ef "$self_path" ]] && return 0

    local candidate_dir
    candidate_dir=$(dirname "$candidate")
    [[ "$candidate_dir" -ef "$YOLO_OVERRIDE_DIR" ]] && return 0
    [[ "$candidate_dir" == "$YOLO_OVERRIDE_DIR" ]] && return 0

    return 1
}

# Resolve the real binary for $2 (claude/codex) into the variable named by $1.
#  1. $3 (the $CLAUDE_BIN/$CODEX_BIN override) wins if set — unless it would
#     recurse back into $4 (the calling wrapper's path) or the override dir.
#  2. Otherwise: first PATH match that would not recurse either way.
# Returns 1 if nothing real was found.
yolo_resolve_real_bin() {
    local -n real_bin_ref="$1"
    local name="$2"
    local env_bin="$3"
    local self_path="$4"
    real_bin_ref=""

    if [[ -n "$env_bin" ]]; then
        if ! yolo_path_recurses_into_wrapper "$env_bin" "$self_path"; then
            real_bin_ref="$env_bin"
            return 0
        fi
        echo "warning: \$${name^^}_BIN ($env_bin) resolves back into the yolo wrapper; ignoring it" >&2
    fi

    local candidate
    while IFS= read -r candidate; do
        [[ -n "$candidate" ]] || continue
        yolo_path_recurses_into_wrapper "$candidate" "$self_path" && continue
        real_bin_ref="$candidate"
        return 0
    done < <(type -aP "$name")

    return 1
}

claudey_setup_backup() {
    local -n backup_msg_ref="$1"
    local repo_root="$2"

    if [[ -z "$repo_root" ]]; then
        unset CLAUDE_BACKUP_PATH
        backup_msg_ref="YOLO MODE ACTIVE. No git repo - no backup available."
        echo "Warning: Not in a git repo, no backup"
        return
    fi

    local backup_dir=""
    claudey_build_backup_dir backup_dir "$repo_root"
    claudey_ensure_backup_repo "$backup_dir" "$repo_root"

    git push --no-verify "$backup_dir" HEAD:refs/heads/claude-checkpoint -f 2>/dev/null
    export CLAUDE_BACKUP_PATH="$backup_dir"
    backup_msg_ref="YOLO MODE ACTIVE. Backup at \$CLAUDE_BACKUP_PATH ($backup_dir)"
    echo "Checkpoint: $backup_dir"
}

codexy_find_workdir() {
    local -n workdir_ref="$1"
    shift
    workdir_ref="$PWD"

    local i=1
    local token=""
    while (( i <= $# )); do
        token="${!i}"

        case "$token" in
            -C|--cd)
                (( i++ ))
                if (( i <= $# )); then
                    workdir_ref="${!i}"
                fi
                ;;
            --cd=*)
                workdir_ref="${token#--cd=}"
                ;;
            --)
                return
                ;;
        esac

        (( i++ ))
    done
}

claudey_build_backup_dir() {
    local -n backup_dir_ref="$1"
    local repo_root="$2"
    local repo_name
    repo_name=$(basename "$repo_root")
    local path_hash
    path_hash=$(yolo_path_hash "$repo_root")

    backup_dir_ref="$HOME/.claude/.claude_repo_backups/${repo_name}-${path_hash}"
}

claudey_ensure_backup_repo() {
    local backup_dir="$1"
    local repo_root="$2"

    if [[ -d "$backup_dir" ]]; then
        return
    fi

    mkdir -p "$backup_dir"
    git init --bare "$backup_dir" > /dev/null
    echo "$repo_root" > "$backup_dir/original_path"
}

# Build the --add-dir set for a claude launch into the array named by $1:
# the launch repo's own skill dirs, the throne root ($3), and this machine's
# personal global skills tree when it has one.
claudey_build_add_dir_args() {
    local -n add_dir_args_ref="$1"
    local repo_root="$2"
    local throne_root="$3"
    add_dir_args_ref=()

    # Set up skill directories at the git repo root.
    if [[ -n "$repo_root" ]]; then
        # agent_docs_local/project-skills: symlinks .claude/skills -> .agents/skills
        # so --add-dir picks up project agent skills automatically
        if [[ -d "$repo_root/.agents/skills" ]]; then
            [[ -d "$repo_root/agent_docs_local/project-skills/.claude" ]] || \
                mkdir -p "$repo_root/agent_docs_local/project-skills/.claude"
            if [[ ! -L "$repo_root/agent_docs_local/project-skills/.claude/skills" ]]; then
                ln -s ../../../.agents/skills "$repo_root/agent_docs_local/project-skills/.claude/skills"
            fi
            add_dir_args_ref+=(--add-dir "$repo_root/agent_docs_local/project-skills")
        fi

        # agent_docs_local/skills: pre-created .claude/skills for manually placed skills
        [[ -d "$repo_root/agent_docs_local/skills/.claude/skills" ]] || \
            mkdir -p "$repo_root/agent_docs_local/skills/.claude/skills"
        add_dir_args_ref+=(--add-dir "$repo_root/agent_docs_local/skills")
    fi

    # The throne's own skills travel with every spawn it makes, including
    # launches whose cwd is some other repo entirely.
    add_dir_args_ref+=(--add-dir "$throne_root")

    # Personal global skills, on machines that have them. Derived from the
    # harness's own discovery link rather than a hardcoded checkout path: the
    # link resolves to <tree>/.claude/skills, so its grandparent is the skills
    # package dir the spawn needs access to. Absent link, absent argument.
    local global_skills_link="$HOME/.claude/skills"
    local global_skills_dir=""
    if [[ -e "$global_skills_link" ]]; then
        global_skills_dir=$(cd -P "$global_skills_link/../.." 2>/dev/null && pwd -P) || global_skills_dir=""
    fi
    if [[ -n "$global_skills_dir" && -d "$global_skills_dir" ]]; then
        add_dir_args_ref+=(--add-dir "$global_skills_dir")
    fi
}

codexy_ensure_prompt_arg() {
    local -n codex_args_ref="$1"
    local backup_msg="$2"
    local i=0
    local token=""

    while (( i < ${#codex_args_ref[@]} )); do
        token="${codex_args_ref[i]}"

        if [[ "$token" == "--" ]]; then
            (( i++ ))
            break
        fi

        if [[ "$token" != -* ]]; then
            case "$token" in
                exec|e)
                    (( i++ ))
                    # Pass the ORIGINAL variable name ($1), not our nameref:
                    # naming a nameref after the callee's own nameref made it
                    # circular and silently no-op'd injection for exec runs
                    # (bug in the pre-port bashrc functions).
                    codexy_ensure_exec_prompt_arg "$1" "$backup_msg" "$i"
                    return
                    ;;
                review|login|logout|mcp|mcp-server|app-server|app|completion|sandbox|debug|apply|a|resume|fork|cloud|features|help)
                    return
                    ;;
                *)
                    codex_args_ref[i]="$backup_msg"$'\n\n'"$token"
                    return
                    ;;
            esac
        fi

        if codexy_option_takes_value "$token" root; then
            (( i++ ))
        fi

        (( i++ ))
    done

    if (( i < ${#codex_args_ref[@]} )); then
        codex_args_ref[i]="$backup_msg"$'\n\n'"${codex_args_ref[i]}"
        return
    fi

    codex_args_ref+=("$backup_msg")
}

codexy_ensure_exec_prompt_arg() {
    # Distinct nameref name from codexy_ensure_prompt_arg's — a nameref that
    # resolves to a variable of its own name is circular in bash.
    local -n exec_codex_args_ref="$1"
    local backup_msg="$2"
    local i="$3"
    local token=""

    while (( i < ${#exec_codex_args_ref[@]} )); do
        token="${exec_codex_args_ref[i]}"

        if [[ "$token" == "--" ]]; then
            (( i++ ))
            break
        fi

        if [[ "$token" != -* ]]; then
            case "$token" in
                resume|review|help)
                    return
                    ;;
                *)
                    exec_codex_args_ref[i]="$backup_msg"$'\n\n'"$token"
                    return
                    ;;
            esac
        fi

        if codexy_option_takes_value "$token" exec; then
            (( i++ ))
        fi

        (( i++ ))
    done

    if (( i < ${#exec_codex_args_ref[@]} )); then
        exec_codex_args_ref[i]="$backup_msg"$'\n\n'"${exec_codex_args_ref[i]}"
        return
    fi

    exec_codex_args_ref+=("$backup_msg")
}

codexy_option_takes_value() {
    local token="$1"
    local mode="$2"

    case "$token" in
        --config=*|--enable=*|--disable=*|--image=*|--model=*|--local-provider=*|--profile=*|--sandbox=*|--ask-for-approval=*|--cd=*|--add-dir=*|--output-schema=*|--color=*|--output-last-message=*)
            return 1
            ;;
    esac

    case "$mode:$token" in
        root:-c|root:--config|root:--enable|root:--disable|root:-i|root:--image|root:-m|root:--model|root:--local-provider|root:-p|root:--profile|root:-s|root:--sandbox|root:-a|root:--ask-for-approval|root:-C|root:--cd|root:--add-dir)
            return 0
            ;;
        exec:-c|exec:--config|exec:--enable|exec:--disable|exec:-i|exec:--image|exec:-m|exec:--model|exec:--local-provider|exec:-p|exec:--profile|exec:-s|exec:--sandbox|exec:-C|exec:--cd|exec:--add-dir|exec:--output-schema|exec:--color|exec:-o|exec:--output-last-message)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}
