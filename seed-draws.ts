import { db } from './server/db';
import { draws } from './shared/schema';
import { addDays, format } from 'date-fns';
import { sql } from 'drizzle-orm';

async function seedDraws() {
  try {
    console.log('Iniciando seed de sorteios...');
    
    // Verificar se já existem sorteios no banco
    const existingDraws = await db.select().from(draws);
    if (existingDraws.length > 0) {
      console.log(`Já existem ${existingDraws.length} sorteios no banco de dados.`);
      
      const forceUpdate = process.argv.includes('--force');
      if (!forceUpdate) {
        console.log('Use --force para substituir os sorteios existentes.');
        return;
      }
      
      console.log('Excluindo sorteios existentes...');
      // Verificar e desativar a restrição de chave estrangeira temporariamente para permitir exclusão
      await db.execute(sql`SET session_replication_role = 'replica'`);
      await db.delete(draws);
      await db.execute(sql`SET session_replication_role = 'origin'`);
    }
    
    // Criar sorteios para os próximos 7 dias
    const today = new Date();
    const drawsList = [];
    
    // Horários padrão dos sorteios
    const drawTimes = [
      { name: 'PT', time: '11:00' },
      { name: 'PTM', time: '14:00' },
      { name: 'PT', time: '16:00' },
      { name: 'PTV', time: '18:00' },
      { name: 'PTN', time: '21:00' }
    ];
    
    // Criar sorteios para os próximos 7 dias
    for (let i = 0; i < 7; i++) {
      const drawDate = addDays(today, i);
      const formattedDate = format(drawDate, 'yyyy-MM-dd');
      
      // Criar sorteios para cada horário padrão
      for (const drawTime of drawTimes) {
        const [hours, minutes] = drawTime.time.split(':').map(Number);
        
        // Verificar se o horário já passou para hoje
        if (i === 0) {
          const currentHour = today.getHours();
          const currentMinute = today.getMinutes();
          
          if (currentHour > hours || (currentHour === hours && currentMinute >= minutes)) {
            continue; // Pular este horário se já passou
          }
        }
        
        // Criar o sorteio com a data no formato correto
        drawsList.push({
          name: drawTime.name,
          date: drawDate, // Usando o objeto Date diretamente
          time: drawTime.time,
          status: 'scheduled'
        });
      }
    }
    
    // Inserir sorteios no banco
    if (drawsList.length === 0) {
      console.log('Não há sorteios para adicionar.');
      return;
    }
    
    const result = await db.insert(draws).values(drawsList);
    
    console.log(`Seed concluído com sucesso! ${drawsList.length} sorteios foram adicionados.`);
    return result;
  } catch (error) {
    console.error('Erro ao executar seed de sorteios:', error);
    throw error;
  }
}

// Executar a função de seed
seedDraws()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Falha na execução do seed:', error);
    process.exit(1);
  });
