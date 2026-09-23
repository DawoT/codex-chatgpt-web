#!/usr/bin/env bash
# ==============================================================================
# Codex Workflow Helper: Gestión Dual de Cuentas, Túnel y Diagnóstico Rápido
# ==============================================================================

# Colores para salida en terminal
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# 1. Función para usar ChatGPT Web ($0 tokens / Túnel MCP sin bloqueos de timeout)
codex-web() {
    echo -e "${GREEN}==> Ejecutando Codex con modelo ChatGPT Web (Túnel MCP)...${NC}"
    # Se añade --ask-for-approval never por defecto para evitar timeouts de 90s en el túnel MCP
    # si el usuario no pasa su propia política de aprobación.
    local args=()
    local has_model=false
    local has_approval=false

    for arg in "$@"; do
        if [[ "$arg" == "-m" || "$arg" == "--model" ]]; then
            has_model=true
        fi
        if [[ "$arg" == "-a" || "$arg" == "--ask-for-approval" || "$arg" == "--dangerously-bypass-approvals-and-sandbox" ]]; then
            has_approval=true
        fi
        args+=("$arg")
    done

    local cmd=("/home/deuz/.local/bin/codex")
    if [ "$has_model" = false ]; then
        cmd+=("-m" "chatgpt-web/high")
    fi
    if [ "$has_approval" = false ]; then
        cmd+=("--ask-for-approval" "never")
    fi

    "${cmd[@]}" "${args[@]}"
}

# 2. Función para usar créditos oficiales de Codex (Tu otra cuenta / API oficial)
codex-api() {
    echo -e "${BLUE}==> Ejecutando Codex con modelo oficial nativo (Créditos Codex)...${NC}"
    local args=()
    local has_model=false

    for arg in "$@"; do
        if [[ "$arg" == "-m" || "$arg" == "--model" ]]; then
            has_model=true
        fi
        args+=("$arg")
    done

    local cmd=("/home/deuz/.local/bin/codex")
    if [ "$has_model" = false ]; then
        cmd+=("-m" "gpt-6-sol")
    fi

    "${cmd[@]}" "${args[@]}"
}

# 3. Comprobación rápida de estado del túnel y daemon local
codex-status() {
    echo -e "${YELLOW}=== Diagnóstico de Estado: Codex Web GPT & Túnel ===${NC}"
    
    # Comprobar daemon HTTP local
    local health_json
    health_json=$(curl -s --connect-timeout 2 http://127.0.0.1:17841/healthz 2>/dev/null)
    
    if [ -n "$health_json" ]; then
        local mode
        local uptime
        local model_reqs
        local active_http
        local active_browser
        
        mode=$(echo "$health_json" | grep -o '"mode":"[^"]*' | cut -d'"' -f4)
        uptime=$(echo "$health_json" | grep -o '"uptime":[0-9.]*' | cut -d':' -f2)
        model_reqs=$(echo "$health_json" | grep -o '"successful_model_catalog_requests":[0-9]*' | cut -d':' -f2)
        active_http=$(echo "$health_json" | grep -o '"active_http_turns":[0-9]*' | cut -d':' -f2)
        active_browser=$(echo "$health_json" | grep -o '"active_browser_turns":[0-9]*' | cut -d':' -f2)
        auto_restarts=$(echo "$health_json" | grep -o '"tunnel_auto_restarts":[0-9]*' | cut -d':' -f2)

        echo -e "● Daemon Local:       ${GREEN}Activo (127.0.0.1:17841)${NC}"
        echo -e "  - Modo:             ${GREEN}${mode}${NC}"
        echo -e "  - Uptime:           ${uptime} segundos"
        echo -e "  - Consultas Modelo: ${model_reqs}"
        echo -e "  - Turnos Activos:   HTTP: ${active_http} | Navegador: ${active_browser}"
        echo -e "  - Auto-Restarts:    ${auto_restarts:-0} (Supervisor Auto-Recuperable)"
    else
        echo -e "● Daemon Local:       ${RED}Inactivo o no responde en puerto 17841${NC}"
    fi

    # Comprobar proceso del túnel
    local tunnel_pid
    tunnel_pid=$(pgrep -f "tunnel-client run" 2>/dev/null | head -n 1)
    if [ -n "$tunnel_pid" ]; then
        echo -e "● Túnel OpenAI:       ${GREEN}En ejecución (PID: ${tunnel_pid})${NC}"
    else
        echo -e "● Túnel OpenAI:       ${YELLOW}No detectado en segundo plano${NC}"
    fi

    # Comprobar MCP Server
    local mcp_pid
    mcp_pid=$(pgrep -f "cli.js mcp" 2>/dev/null | head -n 1)
    if [ -n "$mcp_pid" ]; then
        echo -e "● Servidor MCP Local: ${GREEN}Activo (PID: ${mcp_pid})${NC}"
    else
        echo -e "● Servidor MCP Local: ${YELLOW}No detectado en segundo plano${NC}"
    fi

    echo -e "${YELLOW}====================================================${NC}"
}

# 4. Reiniciar daemon, túnel y MCP con las mismas flags con las que corren en producción
codex-restart() {
    echo -e "${YELLOW}==> Reiniciando servicios Codex Web & Túnel...${NC}"
    local cgw_home="${CODEX_CHATGPT_WEB_HOME:-$HOME/.codex-chatgpt-web}"
    mkdir -p "$cgw_home/logs"

    local pids
    pids=$(pgrep -f "tunnel-client run|cli.js mcp|cli.js serve" 2>/dev/null)
    if [ -n "$pids" ]; then
        kill $pids 2>/dev/null
        sleep 1
        local lingering
        lingering=$(pgrep -f "tunnel-client run|cli.js mcp|cli.js serve" 2>/dev/null)
        if [ -n "$lingering" ]; then
            kill -9 $lingering 2>/dev/null
            sleep 1
        fi
    fi

    # Daemon HTTP local (debe levantarse primero: crea el socket del turn-broker que usa el MCP)
    local runtime_dir
    runtime_dir="$(ls -1d "$cgw_home"/versions/*-linux-x64 2>/dev/null | sort -V | tail -n 1)"
    if [ -z "$runtime_dir" ]; then
        echo -e "${RED}No se encontró ningún runtime en $cgw_home/versions/*-linux-x64; no se relanzan los servicios.${NC}"
        codex-status
        return 1
    fi
    setsid "$runtime_dir/runtime/bun" "$runtime_dir/app/cli.js" serve > "$cgw_home/logs/daemon.log" 2>&1 < /dev/null &
    disown $! 2>/dev/null
    sleep 2

    # Túnel OpenAI con el perfil real en vivo (mismo formato que usa el proceso del túnel)
    setsid "$cgw_home/bin/tunnel-client" run \
        --profile-dir "$cgw_home/tunnel/profiles" \
        --profile codex-chatgpt-web > "$cgw_home/logs/tunnel.log" 2>&1 < /dev/null &
    disown $! 2>/dev/null
    sleep 2

    # Servidor MCP local sobre el socket del turn-broker del daemon recién levantado
    setsid "$runtime_dir/runtime/bun" "$runtime_dir/app/cli.js" mcp \
        --contract native \
        --broker-socket "$cgw_home/runtime/turn-broker.sock" > "$cgw_home/logs/mcp.log" 2>&1 < /dev/null &
    disown $! 2>/dev/null
    sleep 2

    codex-status
}

# 5. Si se invoca como script ejecutable en lugar de 'source'
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    case "$1" in
        web)
            shift
            codex-web "$@"
            ;;
        api)
            shift
            codex-api "$@"
            ;;
        status)
            codex-status
            ;;
        restart)
            codex-restart
            ;;
        *)
            echo "Uso: $0 {web|api|status|restart} [argumentos adicionales]"
            echo ""
            echo "Comandos:"
            echo "  $0 web [prompt]     Lanza Codex con modelo Web (ChatGPT Web $0 tokens)"
            echo "  $0 api [prompt]     Lanza Codex con modelo oficial nativo (Créditos Codex)"
            echo "  $0 status           Comprueba la salud del túnel, daemon y MCP"
            echo "  $0 restart          Reinicia limpiamente el daemon, el túnel y el MCP"
            echo ""
            echo "O puedes cargarlo en tu shell con:"
            echo "  source $0"
            ;;
    esac
fi
