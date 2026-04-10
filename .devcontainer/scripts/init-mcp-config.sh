#!/bin/bash
# Initialize MCP server configuration and settings for Claude Code agents.
# Adapted from claude-medic-aws pattern.
# Merges .mcp.json servers into ~/.claude/.claude.json and copies settings.
# Runs on container start via entrypoint.

CLAUDE_JSON="/home/agent/.claude/.claude.json"
MCP_JSON="/workspace/cht-core/.mcp.json"
SETTINGS_SRC="/workspace/cht-core/.claude/settings.json"
SETTINGS_DST="/home/agent/.claude/settings.json"

# Ensure .claude directory exists
mkdir -p /home/agent/.claude

# --- MCP Server Configuration ---

if [ ! -f "$MCP_JSON" ]; then
    echo "[init-mcp] Warning: No .mcp.json found at $MCP_JSON"
else
    DESIRED_SERVERS=$(jq '.mcpServers' "$MCP_JSON")

    if [ ! -f "$CLAUDE_JSON" ]; then
        echo "[init-mcp] Creating initial Claude config with MCP servers..."
        cat > "$CLAUDE_JSON" << EOF
{
  "mcpServers": $DESIRED_SERVERS
}
EOF
    else
        EXISTING_MCP=$(jq '.mcpServers // {}' "$CLAUDE_JSON")
        MERGED=$(jq -n --argjson existing "$EXISTING_MCP" --argjson desired "$DESIRED_SERVERS" \
            '$existing * $desired')
        jq --argjson mcp "$MERGED" '.mcpServers = $mcp' "$CLAUDE_JSON" > /tmp/claude.json.tmp
        mv /tmp/claude.json.tmp "$CLAUDE_JSON"
        echo "[init-mcp] MCP servers merged into $CLAUDE_JSON"
    fi

    echo "[init-mcp] Configured servers:"
    jq '.mcpServers | keys' "$CLAUDE_JSON" 2>/dev/null
fi

# --- Settings (permissions) ---

if [ -f "$SETTINGS_SRC" ]; then
    if [ ! -f "$SETTINGS_DST" ]; then
        echo "[init-mcp] Installing settings.json..."
        cp "$SETTINGS_SRC" "$SETTINGS_DST"
    else
        echo "[init-mcp] Merging permissions into existing settings..."
        jq -s '.[0] * { permissions: .[1].permissions }' "$SETTINGS_DST" "$SETTINGS_SRC" > /tmp/settings.json.tmp
        mv /tmp/settings.json.tmp "$SETTINGS_DST"
    fi
    echo "[init-mcp] Settings ready at $SETTINGS_DST"
fi
