import { db } from './server/db';
import { animals } from './shared/schema';

async function seedAnimals() {
  try {
    console.log('Iniciando seed de animais...');
    
    // Verificar se já existem animais no banco
    const existingAnimals = await db.select().from(animals);
    if (existingAnimals.length > 0) {
      console.log(`Já existem ${existingAnimals.length} animais no banco de dados.`);
      
      const forceUpdate = process.argv.includes('--force');
      if (!forceUpdate) {
        console.log('Use --force para substituir os animais existentes.');
        return;
      }
      
      console.log('Excluindo animais existentes...');
      await db.delete(animals);
    }
    
    // Definir os animais do jogo do bicho
    const animalsList = [
      {
        group: 1,
        name: 'Avestruz',
        numbers: ['1', '2', '3', '4'],
        image: 'avestruz.png'
      },
      {
        group: 2,
        name: 'Águia',
        numbers: ['5', '6', '7', '8'],
        image: 'aguia.png'
      },
      {
        group: 3,
        name: 'Burro',
        numbers: ['9', '10', '11', '12'],
        image: 'burro.png'
      },
      {
        group: 4,
        name: 'Borboleta',
        numbers: ['13', '14', '15', '16'],
        image: 'borboleta.png'
      },
      {
        group: 5,
        name: 'Cachorro',
        numbers: ['17', '18', '19', '20'],
        image: 'cachorro.png'
      },
      {
        group: 6,
        name: 'Cabra',
        numbers: ['21', '22', '23', '24'],
        image: 'cabra.png'
      },
      {
        group: 7,
        name: 'Carneiro',
        numbers: ['25', '26', '27', '28'],
        image: 'carneiro.png'
      },
      {
        group: 8,
        name: 'Camelo',
        numbers: ['29', '30', '31', '32'],
        image: 'camelo.png'
      },
      {
        group: 9,
        name: 'Cobra',
        numbers: ['33', '34', '35', '36'],
        image: 'cobra.png'
      },
      {
        group: 10,
        name: 'Coelho',
        numbers: ['37', '38', '39', '40'],
        image: 'coelho.png'
      },
      {
        group: 11,
        name: 'Cavalo',
        numbers: ['41', '42', '43', '44'],
        image: 'cavalo.png'
      },
      {
        group: 12,
        name: 'Elefante',
        numbers: ['45', '46', '47', '48'],
        image: 'elefante.png'
      },
      {
        group: 13,
        name: 'Galo',
        numbers: ['49', '50', '51', '52'],
        image: 'galo.png'
      },
      {
        group: 14,
        name: 'Gato',
        numbers: ['53', '54', '55', '56'],
        image: 'gato.png'
      },
      {
        group: 15,
        name: 'Jacaré',
        numbers: ['57', '58', '59', '60'],
        image: 'jacare.png'
      },
      {
        group: 16,
        name: 'Leão',
        numbers: ['61', '62', '63', '64'],
        image: 'leao.png'
      },
      {
        group: 17,
        name: 'Macaco',
        numbers: ['65', '66', '67', '68'],
        image: 'macaco.png'
      },
      {
        group: 18,
        name: 'Porco',
        numbers: ['69', '70', '71', '72'],
        image: 'porco.png'
      },
      {
        group: 19,
        name: 'Pavão',
        numbers: ['73', '74', '75', '76'],
        image: 'pavao.png'
      },
      {
        group: 20,
        name: 'Peru',
        numbers: ['77', '78', '79', '80'],
        image: 'peru.png'
      },
      {
        group: 21,
        name: 'Touro',
        numbers: ['81', '82', '83', '84'],
        image: 'touro.png'
      },
      {
        group: 22,
        name: 'Tigre',
        numbers: ['85', '86', '87', '88'],
        image: 'tigre.png'
      },
      {
        group: 23,
        name: 'Urso',
        numbers: ['89', '90', '91', '92'],
        image: 'urso.png'
      },
      {
        group: 24,
        name: 'Veado',
        numbers: ['93', '94', '95', '96'],
        image: 'veado.png'
      },
      {
        group: 25,
        name: 'Vaca',
        numbers: ['97', '98', '99', '0'],
        image: 'vaca.png'
      }
    ];
    
    // Inserir animais no banco
    const result = await db.insert(animals).values(animalsList);
    
    console.log(`Seed concluído com sucesso! ${animalsList.length} animais foram adicionados.`);
    return result;
  } catch (error) {
    console.error('Erro ao executar seed de animais:', error);
    throw error;
  }
}

// Executar a função de seed
seedAnimals()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Falha na execução do seed:', error);
    process.exit(1);
  });
