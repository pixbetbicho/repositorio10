#!/bin/bash

# Script completo para deploy do BichoBet
# Este script faz o download do código fonte completo e realiza o build e deploy

# Definir variáveis
REPO_URL="https://github.com/SEU_USUARIO/SEU_REPOSITORIO.git"  # Substitua com o URL do seu repositório
BRANCH="main"
APP_DIR="/workspace/bichobet"

echo "===== INICIANDO DEPLOY COMPLETO ====="
echo "Diretório atual: $(pwd)"

# Preparar o ambiente
export NODE_ENV=production

# Limpar a área de trabalho
if [ -d "$APP_DIR" ]; then
  echo "Removendo diretório anterior..."
  rm -rf "$APP_DIR"
fi

# Criar diretório do aplicativo
mkdir -p "$APP_DIR"
cd "$APP_DIR"

# Fazer download do código fonte completo
echo "Fazendo download do código fonte do repositório: $REPO_URL ($BRANCH)"
if [ -z "$REPO_URL" ] || [ "$REPO_URL" = "https://github.com/SEU_USUARIO/SEU_REPOSITORIO.git" ]; then
  echo "AVISO: URL do repositório não configurado. Usando arquivos existentes."
  cp -r /workspace/* .
else
  git clone -b "$BRANCH" "$REPO_URL" .
  if [ $? -ne 0 ]; then
    echo "ERRO: Falha ao clonar o repositório. Usando arquivos existentes."
    cp -r /workspace/* .
  fi
fi

# Verificar se os diretórios essenciais existem
if [ ! -d "client" ] || [ ! -d "server" ]; then
  echo "ERRO: Estrutura de diretórios inválida. Verifique se client/ e server/ existem."
  echo "Conteúdo atual:"
  ls -la
  exit 1
fi

# Instalar dependências
echo "Instalando dependências..."
npm install

# Build do cliente (frontend)
echo "Iniciando build do cliente..."
cd client
../node_modules/.bin/vite build
BUILD_RESULT=$?
if [ $BUILD_RESULT -ne 0 ]; then
  echo "ERRO: O build do cliente falhou com código $BUILD_RESULT"
  exit 1
fi
cd ..

# Build do servidor (backend)
echo "Iniciando build do servidor..."
./node_modules/.bin/esbuild server/index.ts --platform=node --packages=external --bundle --format=esm --outdir=dist
BUILD_RESULT=$?
if [ $BUILD_RESULT -ne 0 ]; then
  echo "ERRO: O build do servidor falhou com código $BUILD_RESULT"
  exit 1
fi

# Iniciar o servidor
echo "Iniciando o servidor..."
node dist/index.js
