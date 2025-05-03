import { db } from './server/db';
import { gameModes } from './shared/schema';

async function seedGameModes() {
  try {
    console.log('Iniciando seed de modalidades de jogo...');
    
    // Verificar se já existem modalidades no banco
    const existingModes = await db.select().from(gameModes);
    if (existingModes.length > 0) {
      console.log(`Já existem ${existingModes.length} modalidades no banco de dados.`);
      console.log('Modalidades existentes:', existingModes.map(m => m.name).join(', '));
      
      const forceUpdate = process.argv.includes('--force');
      if (!forceUpdate) {
        console.log('Use --force para substituir as modalidades existentes.');
        return;
      }
      
      console.log('Excluindo modalidades existentes...');
      await db.delete(gameModes);
    }
    
    // Definir modalidades de jogo
    const modes = [
      {
        name: 'Grupo',
        description: 'Jogo no grupo (bicho)',
        odds: 1800, // 18.00 * 100
        active: true
      },
      {
        name: 'Dezena',
        description: 'Jogo na dezena',
        odds: 6000, // 60.00 * 100
        active: true
      },
      {
        name: 'Centena',
        description: 'Jogo na centena',
        odds: 60000, // 600.00 * 100
        active: true
      },
      {
        name: 'Milhar',
        description: 'Jogo na milhar',
        odds: 400000, // 4000.00 * 100
        active: true
      },
      {
        name: 'Duque de Grupo',
        description: 'Apostar em dois grupos',
        odds: 1850, // 18.50 * 100
        active: false
      }
    ];
    
    // Inserir modalidades no banco
    const result = await db.insert(gameModes).values(modes);
    
    console.log(`Seed concluído com sucesso! ${modes.length} modalidades de jogo foram adicionadas.`);
    return result;
  } catch (error) {
    console.error('Erro ao executar seed de modalidades de jogo:', error);
    throw error;
  }
}

// Executar a função de seed
seedGameModes()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Falha na execução do seed:', error);
    process.exit(1);
  });
