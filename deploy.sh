#!/bin/bash

# Script para iniciar o aplicativo na DigitalOcean

# Adicionar logs detalhados para debug
echo "===== INICIANDO DEPLOY.SH ====="
echo "Diretório atual: $(pwd)"
echo "Conteúdo do diretório atual:"
ls -la

# Definir variáveis de ambiente necessárias
export NODE_ENV=production
echo "NODE_ENV definido como: $NODE_ENV"

# Garantir que estamos no diretório correto do projeto
echo "Tentando navegar para o diretório do projeto..."

# Tente vários caminhos possíveis
if [ -d "/workspace" ]; then
  cd /workspace
  echo "Navegado para /workspace"
fi

echo "Novo diretório atual: $(pwd)"
echo "Conteúdo do diretório atual após navegação:"
ls -la

# Verificar se as dependencias estão instaladas
if [ ! -d "node_modules" ]; then
  echo "Dependencias não encontradas, instalando..."
  npm install --production
else
  echo "Diretório node_modules encontrado"
fi

# Verificar se o diretório dist existe
if [ ! -d "dist" ]; then
  echo "Diretório dist não encontrado, o build pode ter falhado!"
  echo "Conteúdo do diretório atual:"
  ls -la
  exit 1
else
  echo "Diretório dist encontrado"
  echo "Conteúdo do diretório dist:"
  ls -la dist/
fi

# Verificar variáveis de ambiente críticas
echo "Verificando variáveis de ambiente:"
if [ -z "$DATABASE_URL" ]; then
  echo "AVISO: DATABASE_URL não está definida"
else
  echo "DATABASE_URL está definida"
fi

if [ -z "$SESSION_SECRET" ]; then
  echo "AVISO: SESSION_SECRET não está definida, usando valor padrão"
  export SESSION_SECRET="bichobet-secret-key-temporary"
else
  echo "SESSION_SECRET está definida"
fi

# Iniciar o servidor
echo "Iniciando o servidor..."
echo "Comando: node dist/index.js"
node dist/index.js
