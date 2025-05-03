/**
 * Script para construir o frontend do cliente diretamente
 * Usado para contornar problemas de caminho no DigitalOcean
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// Diretório atual
const currentDir = process.cwd();
console.log(`Diretório atual: ${currentDir}`);

// Verificar se estamos no diretório cliente
const isClientDir = fs.existsSync(path.join(currentDir, 'index.html'));
console.log(`Estamos no diretório cliente? ${isClientDir}`);

// Executar o comando de build do Vite
try {
  console.log('Iniciando build do cliente...');
  execSync('npx vite build', { stdio: 'inherit' });
  console.log('Build do cliente concluído com sucesso!');
} catch (error) {
  console.error('Erro durante o build do cliente:', error);
  process.exit(1);
}
