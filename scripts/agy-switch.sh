#!/usr/bin/env bash
# agy-switch — troca de conta Google no Antigravity CLI
#
# Uso:
#   agy-switch save <nome>    salva o token atual com um nome
#   agy-switch use <nome>     restaura o token e abre o agy
#   agy-switch list           lista perfis salvos
#   agy-switch current        mostra qual perfil está ativo
#   agy-switch delete <nome>  remove um perfil
#   agy-switch logout         apaga o token atual do Keychain

set -euo pipefail

PROFILES_DIR="${HOME}/.agy-profiles"
KEYCHAIN_SERVICE="gemini"
KEYCHAIN_ACCOUNT="antigravity"
ACTIVE_FILE="${PROFILES_DIR}/.active"

mkdir -p "${PROFILES_DIR}"
chmod 700 "${PROFILES_DIR}"

_red()    { echo -e "\033[31m$*\033[0m"; }
_green()  { echo -e "\033[32m$*\033[0m"; }
_yellow() { echo -e "\033[33m$*\033[0m"; }
_bold()   { echo -e "\033[1m$*\033[0m"; }

_keychain_get() {
  security find-generic-password \
    -s "${KEYCHAIN_SERVICE}" \
    -a "${KEYCHAIN_ACCOUNT}" \
    -w 2>/dev/null || true
}

_keychain_set() {
  local token="$1"
  security delete-generic-password \
    -s "${KEYCHAIN_SERVICE}" \
    -a "${KEYCHAIN_ACCOUNT}" 2>/dev/null || true
  security add-generic-password \
    -s "${KEYCHAIN_SERVICE}" \
    -a "${KEYCHAIN_ACCOUNT}" \
    -w "${token}"
}

_keychain_delete() {
  security delete-generic-password \
    -s "${KEYCHAIN_SERVICE}" \
    -a "${KEYCHAIN_ACCOUNT}" 2>/dev/null || true
}

_profile_path() { echo "${PROFILES_DIR}/$1.token"; }
_profile_exists() { [[ -f "$(_profile_path "$1")" ]]; }

_require_name() {
  if [[ -z "${1:-}" ]]; then
    _red "Erro: informe o nome do perfil."
    echo "Uso: agy-switch $2 <nome>"
    exit 1
  fi
}

cmd_save() {
  _require_name "${1:-}" "save"
  local name="$1"
  local token
  token="$(_keychain_get)"

  if [[ -z "${token}" ]]; then
    _red "Nenhum token encontrado. Faça login no agy primeiro."
    exit 1
  fi

  echo "${token}" > "$(_profile_path "${name}")"
  chmod 600 "$(_profile_path "${name}")"
  echo "${name}" > "${ACTIVE_FILE}"
  _green "✓ Perfil '${name}' salvo."
}

cmd_use() {
  _require_name "${1:-}" "use"
  local name="$1"

  if ! _profile_exists "${name}"; then
    _red "Perfil '${name}' não encontrado."
    echo ""; cmd_list
    exit 1
  fi

  local token
  token="$(cat "$(_profile_path "${name}")")"

  if [[ -z "${token}" ]]; then
    _red "Arquivo do perfil '${name}' está vazio ou corrompido."
    exit 1
  fi

  _keychain_set "${token}"
  echo "${name}" > "${ACTIVE_FILE}"
  _green "✓ Conta '${name}' ativa."
  _bold "Iniciando agy..."
  exec agy
}

cmd_list() {
  local active=""
  [[ -f "${ACTIVE_FILE}" ]] && active="$(cat "${ACTIVE_FILE}")"
  local found=0

  for f in "${PROFILES_DIR}"/*.token; do
    [[ -f "${f}" ]] || continue
    found=1
    local name
    name="$(basename "${f}" .token)"
    if [[ "${name}" == "${active}" ]]; then
      _green "  ● ${name} (ativo)"
    else
      echo "  ○ ${name}"
    fi
  done

  [[ "${found}" -eq 0 ]] && _yellow "Nenhum perfil salvo. Use: agy-switch save <nome>"
}

cmd_current() {
  if [[ -f "${ACTIVE_FILE}" ]]; then
    _bold "Perfil ativo: $(cat "${ACTIVE_FILE}")"
  else
    _yellow "Nenhum perfil ativo. Use: agy-switch save <nome>"
  fi
}

cmd_delete() {
  _require_name "${1:-}" "delete"
  local name="$1"
  _profile_exists "${name}" || { _red "Perfil '${name}' não encontrado."; exit 1; }
  rm "$(_profile_path "${name}")"
  if [[ -f "${ACTIVE_FILE}" ]] && [[ "$(cat "${ACTIVE_FILE}")" == "${name}" ]]; then
    rm "${ACTIVE_FILE}"
  fi
  _green "✓ Perfil '${name}' removido."
}

cmd_logout() {
  _keychain_delete
  [[ -f "${ACTIVE_FILE}" ]] && rm "${ACTIVE_FILE}"
  _green "✓ Token removido. Próximo 'agy' vai pedir login."
}

cmd_help() {
  _bold "agy-switch — gerenciador de contas do Antigravity CLI"
  echo ""
  echo "Fluxo de uso:"
  echo "  1. Faça login com a conta A no agy, salve:"
  echo "       agy-switch save enzotironi"
  echo "  2. Logout + login com a conta B, salve:"
  echo "       agy-switch save yesderela"
  echo "  3. Troque entre contas a qualquer momento:"
  echo "       agy-switch use enzotironi"
  echo "       agy-switch use yesderela"
  echo ""
  _bold "Comandos:"
  echo "  save <nome>     Salva o token atual"
  echo "  use <nome>      Restaura o token e abre o agy"
  echo "  list            Lista todos os perfis"
  echo "  current         Mostra o perfil ativo"
  echo "  delete <nome>   Remove um perfil"
  echo "  logout          Apaga o token do Keychain"
  echo "  help            Esta mensagem"
  echo ""
  _yellow "Tokens ficam em: ${PROFILES_DIR}/ (chmod 600)"
}

COMMAND="${1:-help}"
shift || true

case "${COMMAND}" in
  save)    cmd_save "$@" ;;
  use)     cmd_use "$@" ;;
  list)    cmd_list ;;
  current) cmd_current ;;
  delete)  cmd_delete "$@" ;;
  logout)  cmd_logout ;;
  help|--help|-h) cmd_help ;;
  *)
    _red "Comando desconhecido: '${COMMAND}'"
    echo ""; cmd_help; exit 1 ;;
esac
