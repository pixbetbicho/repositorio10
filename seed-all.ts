import { hashPassword } from './server/auth';
import { db } from './server/db';
import { users, gameModes, animals, draws } from './shared/schema';
import { addDays, format } from 'date-fns';

async function initializeAll() {
  try {
    console.log('Iniciando seed completo do banco de dados...');
    
    // Verificar se já há dados no banco
    const [existingUsers, existingAnimals, existingGameModes, existingDraws, existingSettings] = await Promise.all([
      db.select().from(users),
      db.select().from(animals),
      db.select().from(gameModes),
      db.select().from(draws),
      db.select().from(systemSettings)
    ]);
    
    const forceUpdate = process.argv.includes('--force');
    
    if ((existingUsers.length || existingAnimals.length || existingGameModes.length || existingDraws.length) && !forceUpdate) {
      console.log('Já existem dados no banco. Use --force para substituir todos os dados existentes.');
      console.log(`- Usuários: ${existingUsers.length}`);
      console.log(`- Animais: ${existingAnimals.length}`);
      console.log(`- Modalidades: ${existingGameModes.length}`);
      console.log(`- Sorteios: ${existingDraws.length}`);
      console.log(`- Configurações: ${existingSettings.length}`);
      return;
    }
    
    if (forceUpdate) {
      console.log('Excluindo todos os dados existentes...');
      // Remover dados existentes (na ordem correta para evitar violações de FK)
      await db.delete(draws);
      await db.delete(gameModes);
      await db.delete(animals);
      await db.delete(systemSettings);
      await db.delete(users);
    }
    
    console.log('Adicionando usuário admin...');
    // Criar usuário admin
    await db.insert(users).values({
      username: 'admin',
      password: await hashPassword('admin'),
      email: 'admin@bichomania.com',
      name: 'Administrador',
      balance: 1000,
      isAdmin: true,
      createdAt: new Date()
    });
    
    console.log('Adicionando configurações do sistema...');
    // Configurar as configurações do sistema
    await db.insert(systemSettings).values({
      maxBetAmount: 10000,
      maxPayout: 10000,
      minBetAmount: 2, // Valor mínimo de aposta
      defaultBetAmount: 10, // Valor padrão de aposta
      mainColor: '#035faf',
      secondaryColor: '#b0d525',
      accentColor: '#b0d524',
      allowUserRegistration: true,
      allowDeposits: true,
      allowWithdrawals: true,
      maintenanceMode: false,
      autoApproveWithdrawals: true,
      autoApproveWithdrawalLimit: 30
    });
    
    console.log('Adicionando modalidades de jogo...');
    // Definir modalidades de jogo
    const modes = [
      {
        name: 'Grupo',
        description: 'Jogo no grupo (bicho)',
        minValue: 1,
        maxValue: 25,
        quotation: 18,
        active: true
      },
      {
        name: 'Dezena',
        description: 'Jogo na dezena',
        minValue: 0,
        maxValue: 99,
        quotation: 60,
        active: true
      },
      {
        name: 'Centena',
        description: 'Jogo na centena',
        minValue: 0,
        maxValue: 999,
        quotation: 600,
        active: true
      },
      {
        name: 'Milhar',
        description: 'Jogo na milhar',
        minValue: 0,
        maxValue: 9999,
        quotation: 4000,
        active: true
      },
      {
        name: 'Duque de Grupo',
        description: 'Apostar em dois grupos',
        minValue: 1,
        maxValue: 25,
        quotation: 18.5,
        active: false
      }
    ];
    await db.insert(gameModes).values(modes);
    
    console.log('Adicionando animais...');
    // Definir os animais do jogo do bicho
    const animalsList = [
      {
        group: 1,
        name: 'Avestruz',
        numbers: [1, 2, 3, 4],
        image: 'avestruz.png'
      },
      {
        group: 2,
        name: 'Águia',
        numbers: [5, 6, 7, 8],
        image: 'aguia.png'
      },
      {
        group: 3,
        name: 'Burro',
        numbers: [9, 10, 11, 12],
        image: 'burro.png'
      },
      {
        group: 4,
        name: 'Borboleta',
        numbers: [13, 14, 15, 16],
        image: 'borboleta.png'
      },
      {
        group: 5,
        name: 'Cachorro',
        numbers: [17, 18, 19, 20],
        image: 'cachorro.png'
      },
      {
        group: 6,
        name: 'Cabra',
        numbers: [21, 22, 23, 24],
        image: 'cabra.png'
      },
      {
        group: 7,
        name: 'Carneiro',
        numbers: [25, 26, 27, 28],
        image: 'carneiro.png'
      },
      {
        group: 8,
        name: 'Camelo',
        numbers: [29, 30, 31, 32],
        image: 'camelo.png'
      },
      {
        group: 9,
        name: 'Cobra',
        numbers: [33, 34, 35, 36],
        image: 'cobra.png'
      },
      {
        group: 10,
        name: 'Coelho',
        numbers: [37, 38, 39, 40],
        image: 'coelho.png'
      },
      {
        group: 11,
        name: 'Cavalo',
        numbers: [41, 42, 43, 44],
        image: 'cavalo.png'
      },
      {
        group: 12,
        name: 'Elefante',
        numbers: [45, 46, 47, 48],
        image: 'elefante.png'
      },
      {
        group: 13,
        name: 'Galo',
        numbers: [49, 50, 51, 52],
        image: 'galo.png'
      },
      {
        group: 14,
        name: 'Gato',
        numbers: [53, 54, 55, 56],
        image: 'gato.png'
      },
      {
        group: 15,
        name: 'Jacaré',
        numbers: [57, 58, 59, 60],
        image: 'jacare.png'
      },
      {
        group: 16,
        name: 'Leão',
        numbers: [61, 62, 63, 64],
        image: 'leao.png'
      },
      {
        group: 17,
        name: 'Macaco',
        numbers: [65, 66, 67, 68],
        image: 'macaco.png'
      },
      {
        group: 18,
        name: 'Porco',
        numbers: [69, 70, 71, 72],
        image: 'porco.png'
      },
      {
        group: 19,
        name: 'Pavão',
        numbers: [73, 74, 75, 76],
        image: 'pavao.png'
      },
      {
        group: 20,
        name: 'Peru',
        numbers: [77, 78, 79, 80],
        image: 'peru.png'
      },
      {
        group: 21,
        name: 'Touro',
        numbers: [81, 82, 83, 84],
        image: 'touro.png'
      },
      {
        group: 22,
        name: 'Tigre',
        numbers: [85, 86, 87, 88],
        image: 'tigre.png'
      },
      {
        group: 23,
        name: 'Urso',
        numbers: [89, 90, 91, 92],
        image: 'urso.png'
      },
      {
        group: 24,
        name: 'Veado',
        numbers: [93, 94, 95, 96],
        image: 'veado.png'
      },
      {
        group: 25,
        name: 'Vaca',
        numbers: [97, 98, 99, 0],
        image: 'vaca.png'
      }
    ];
    await db.insert(animals).values(animalsList);
    
    console.log('Adicionando sorteios...');
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
      const dateStr = format(drawDate, 'yyyy-MM-dd');
      
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
        
        // Criar o sorteio
        drawsList.push({
          name: drawTime.name,
          date: dateStr,
          time: drawTime.time,
          status: 'scheduled',
          resultAnimalId: null,
          resultAnimalId2: null,
          resultAnimalId3: null,
          resultAnimalId4: null,
          resultAnimalId5: null
        });
      }
    }
    
    if (drawsList.length > 0) {
      await db.insert(draws).values(drawsList);
    }
    
    console.log('Seed completo realizado com sucesso!');
    console.log(`- Usuários: 1`);
    console.log(`- Animais: ${animalsList.length}`);
    console.log(`- Modalidades: ${modes.length}`);
    console.log(`- Sorteios: ${drawsList.length}`);
    console.log(`- Configurações: 1`);
  } catch (error) {
    console.error('Erro ao executar seed completo:', error);
    throw error;
  }
}

// Executar a função de seed
initializeAll()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Falha na execução do seed:', error);
    process.exit(1);
  });
