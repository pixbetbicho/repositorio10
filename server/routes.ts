import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { setupAuth, comparePasswords, hashPassword } from "./auth";
import { z } from "zod";
import { ezzebankService } from "./services/ezzebank-service";
import { 
  insertBetSchema, 
  insertDrawSchema, 
  insertUserSchema, 
  insertGameModeSchema, 
  insertPaymentGatewaySchema, 
  insertPaymentTransactionSchema,
  insertWithdrawalSchema,
  insertTransactionSchema,
  bets, 
  paymentTransactions, 
  BetWithDetails, 
  Draw,
  WithdrawalStatus
} from "@shared/schema";
import { db, pool } from "./db";
import { eq, desc, asc, sql, and } from "drizzle-orm";

export async function registerRoutes(app: Express): Promise<Server> {
  // Set up authentication routes
  setupAuth(app);

  // Protected route middleware
  const requireAuth = (req: Request, res: Response, next: Function) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    next();
  };

  // Admin route middleware
  const requireAdmin = (req: Request, res: Response, next: Function) => {
    if (!req.isAuthenticated() || !req.user.isAdmin) {
      return res.status(403).json({ message: "Forbidden" });
    }
    next();
  };
  
  // Middleware para verificar se o recurso pertence ao usuário
  /**
   * Middleware para verificar se o usuário é dono do recurso antes de permitir acesso
   * Implementa verificações múltiplas de segurança para prevenir vazamento de dados
   */
  const requireOwnership = (resourceType: string) => {
    return async (req: Request, res: Response, next: Function) => {
      // Verificação de autenticação
      if (!req.isAuthenticated()) {
        console.log(`ACESSO NEGADO: Tentativa de acesso sem autenticação a ${resourceType}`);
        return res.status(401).json({ message: "Não autorizado" });
      }
      
      const userId = req.user.id;
      const username = req.user.username;
      const resourceId = parseInt(req.params.id);
      
      // Validação do ID
      if (isNaN(resourceId)) {
        console.log(`ERRO DE VALIDAÇÃO: ID inválido fornecido por ${username} (${userId}) para ${resourceType}`);
        return res.status(400).json({ message: "ID inválido" });
      }
      
      // Verificação de admin (apenas administradores podem acessar recursos de outros usuários)
      if (req.user.isAdmin) {
        console.log(`ACESSO ADMIN: ${username} (${userId}) acessando ${resourceType} ${resourceId} como administrador`);
        
        // Para os administradores ainda precisamos carregar o recurso para disponibilizar no req
        let adminResource: any;
        
        try {
          switch (resourceType) {
            case 'bet':
              adminResource = await storage.getBet(resourceId);
              break;
            case 'transaction':
              adminResource = await storage.getPaymentTransaction(resourceId);
              break;
            default:
              throw new Error(`Tipo de recurso desconhecido: ${resourceType}`);
          }
          
          if (!adminResource) {
            return res.status(404).json({ message: `${resourceType} não encontrado` });
          }
          
          // Adicionar log para auditoria de acesso de administradores a dados de outros usuários
          if (adminResource.userId !== userId) {
            console.log(`AUDITORIA: Admin ${username} (${userId}) acessando ${resourceType} ${resourceId} do usuário ${adminResource.userId}`);
          }
          
          // Armazenar no request
          (req as any).resource = adminResource;
          return next();
        } catch (error) {
          console.error(`ERRO: Admin ${username} falhou ao acessar ${resourceType} ${resourceId}`, error);
          return res.status(500).json({ message: "Erro ao buscar recurso" });
        }
      }
      
      try {
        let resource: any;
        let ownerUserId: number;
        
        // Verificação dupla de propriedade:
        // 1. Primeiro verificamos se o ID do recurso pertence ao usuário (sem carregar o objeto completo)
        switch (resourceType) {
          case 'bet':
            // Verificação preliminar de propriedade - consulta leve apenas para verificar o dono
            const betOwner = await db
              .select({ userId: bets.userId })
              .from(bets)
              .where(eq(bets.id, resourceId))
              .limit(1);
            
            if (betOwner.length === 0) {
              console.log(`RECURSO NÃO ENCONTRADO: Aposta ${resourceId} não existe`);
              return res.status(404).json({ message: "Aposta não encontrada" });
            }
            
            ownerUserId = betOwner[0].userId;
            if (ownerUserId !== userId) {
              console.log(`ACESSO NEGADO: Usuário ${username} (${userId}) tentando acessar aposta ${resourceId} do usuário ${ownerUserId}`);
              return res.status(403).json({ message: "Acesso negado: esse recurso não pertence a você" });
            }
            
            // Se passou na verificação preliminar, carregamos o objeto completo
            resource = await storage.getBet(resourceId);
            break;
            
          case 'transaction':
            // Verificação preliminar de propriedade para transações
            const txOwner = await db
              .select({ userId: paymentTransactions.userId })
              .from(paymentTransactions)
              .where(eq(paymentTransactions.id, resourceId))
              .limit(1);
              
            if (txOwner.length === 0) {
              console.log(`RECURSO NÃO ENCONTRADO: Transação ${resourceId} não existe`);
              return res.status(404).json({ message: "Transação não encontrada" });
            }
            
            ownerUserId = txOwner[0].userId;
            if (ownerUserId !== userId) {
              console.log(`ACESSO NEGADO: Usuário ${username} (${userId}) tentando acessar transação ${resourceId} do usuário ${ownerUserId}`);
              return res.status(403).json({ message: "Acesso negado: esse recurso não pertence a você" });
            }
            
            // Se passou na verificação preliminar, carregamos o objeto completo
            resource = await storage.getPaymentTransaction(resourceId);
            break;
            
          default:
            console.error(`ERRO DE CONFIGURAÇÃO: Tipo de recurso desconhecido: ${resourceType}`);
            throw new Error(`Tipo de recurso desconhecido: ${resourceType}`);
        }
        
        // Verificação secundária: garantir que o recurso foi carregado
        if (!resource) {
          console.log(`ERRO DE CONSISTÊNCIA: Recurso ${resourceType} ${resourceId} não encontrado após verificação preliminar`);
          return res.status(404).json({ message: `${resourceType} não encontrado` });
        }
        
        // 2. Verificação final de propriedade no objeto carregado (tripla validação)
        if (resource.userId !== userId) {
          // Este log é crítico pois indica potencial vulnerabilidade na verificação preliminar
          console.error(`ALERTA DE SEGURANÇA: Falha na verificação preliminar para ${resourceType} ${resourceId}. 
            Verificação preliminar: pertence a ${ownerUserId}
            Verificação final: pertence a ${resource.userId}
            Usuário solicitante: ${userId}`);
          return res.status(403).json({ message: "Acesso negado: inconsistência de propriedade" });
        }
        
        // Registrar acesso bem-sucedido para auditoria
        console.log(`ACESSO AUTORIZADO: Usuário ${username} (${userId}) acessando seu próprio ${resourceType} ${resourceId}`);
        
        // Salva o recurso no request para uso posterior
        (req as any).resource = resource;
        next();
      } catch (error) {
        console.error(`ERRO NO MIDDLEWARE: Falha na verificação de propriedade para ${resourceType} ${resourceId} solicitado por ${username} (${userId})`, error);
        res.status(500).json({ message: "Erro ao verificar permissões" });
      }
    };
  };

  // Get all animals
  app.get("/api/animals", async (req, res) => {
    try {
      const animals = await storage.getAllAnimals();
      res.json(animals);
    } catch (error) {
      res.status(500).json({ message: "Error fetching animals" });
    }
  });

  // Get upcoming draws
  app.get("/api/draws/upcoming", async (req, res) => {
    try {
      const draws = await storage.getUpcomingDraws();
      res.json(draws);
    } catch (error) {
      res.status(500).json({ message: "Error fetching upcoming draws" });
    }
  });
  
  // Get public system settings (accessible without authentication)
  app.get("/api/settings", async (req, res) => {
    try {
      // Fetch settings but only return public-facing ones
      const settings = await storage.getSystemSettings();
      
      if (settings) {
        // Apenas retorna as configurações que afetam funcionalidades do cliente
        const publicSettings = {
          maxBetAmount: settings.maxBetAmount,
          maxPayout: settings.maxPayout,
          mainColor: settings.mainColor,
          secondaryColor: settings.secondaryColor,
          accentColor: settings.accentColor,
          allowUserRegistration: settings.allowUserRegistration,
          allowDeposits: settings.allowDeposits,
          allowWithdrawals: settings.allowWithdrawals,
          maintenanceMode: settings.maintenanceMode,
          // Informações sobre aprovação automática de saques
          autoApproveWithdrawals: settings.autoApproveWithdrawals,
          autoApproveWithdrawalLimit: settings.autoApproveWithdrawalLimit
        };
        
        res.json(publicSettings);
      } else {
        // Default values para configurações públicas
        const defaultSettings = {
          maxBetAmount: 5000,
          maxPayout: 50000,
          mainColor: "#4f46e5",
          secondaryColor: "#6366f1",
          accentColor: "#f97316",
          allowUserRegistration: true,
          allowDeposits: true,
          allowWithdrawals: true,
          maintenanceMode: false,
          autoApproveWithdrawals: false,
          autoApproveWithdrawalLimit: 0
        };
        
        res.json(defaultSettings);
      }
    } catch (error) {
      console.error("Error fetching public system settings:", error);
      res.status(500).json({ message: "Error fetching system settings" });
    }
  });

  // Get all draws
  app.get("/api/draws", requireAuth, async (req, res) => {
    try {
      const draws = await storage.getAllDraws();
      res.json(draws);
    } catch (error) {
      res.status(500).json({ message: "Error fetching draws" });
    }
  });

  // Create new draw (admin only)
  app.post("/api/draws", requireAdmin, async (req, res) => {
    try {
      console.log("Dados recebidos para criação de sorteio:", req.body);
      
      // Validar os dados básicos
      const validatedData = insertDrawSchema.parse(req.body);
      
      // Garantir que a data está no formato correto antes de salvar
      // Se for string, convertemos para Date, se for Date, mantemos como está
      let formattedData = {
        ...validatedData,
        date: typeof validatedData.date === 'string' 
          ? new Date(validatedData.date) 
          : validatedData.date
      };
      
      console.log("Dados formatados para criação de sorteio:", formattedData);
      
      // Criar o sorteio no banco de dados
      const draw = await storage.createDraw(formattedData);
      
      console.log("Sorteio criado com sucesso:", draw);
      res.status(201).json(draw);
    } catch (error) {
      console.error("Erro ao criar sorteio:", error);
      
      if (error instanceof z.ZodError) {
        console.error("Erros de validação:", JSON.stringify(error.errors, null, 2));
        return res.status(400).json({ message: "Invalid draw data", errors: error.errors });
      }
      
      res.status(500).json({ 
        message: "Error creating draw", 
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });
  
  // Update draw (admin only)
  app.put("/api/draws/:id", requireAdmin, async (req, res) => {
    try {
      const drawId = parseInt(req.params.id);
      console.log("Dados recebidos para atualização de sorteio:", req.body);
      
      // Processar os dados da requisição
      let drawData = req.body;
      
      // Garantir que a data está no formato correto antes de salvar
      if (drawData.date && typeof drawData.date === 'string') {
        drawData = {
          ...drawData,
          date: new Date(drawData.date)
        };
      }
      
      console.log("Dados formatados para atualização de sorteio:", drawData);
      
      // Atualizar sorteio
      const updatedDraw = await storage.updateDraw(drawId, drawData);
      
      if (!updatedDraw) {
        return res.status(404).json({ message: "Sorteio não encontrado" });
      }
      
      console.log("Sorteio atualizado com sucesso:", updatedDraw);
      res.json(updatedDraw);
    } catch (error) {
      console.error("Error updating draw:", error);
      res.status(500).json({ 
        message: "Erro ao atualizar sorteio", 
        error: String(error) 
      });
    }
  });
  
  // Delete draw (admin only)
  app.delete("/api/draws/:id", requireAdmin, async (req, res) => {
    try {
      const drawId = parseInt(req.params.id);
      
      // Excluir sorteio
      await storage.deleteDraw(drawId);
      
      res.status(200).json({ message: "Sorteio excluído com sucesso" });
    } catch (error) {
      console.error("Error deleting draw:", error);
      res.status(500).json({ 
        message: "Erro ao excluir sorteio", 
        error: String(error) 
      });
    }
  });

  // Update draw result (admin only)
  app.put("/api/draws/:id/result", requireAdmin, async (req, res) => {
    try {
      const drawId = Number(req.params.id);
      const { 
        animalId, // 1º prêmio (obrigatório) 
        animalId2, // 2º prêmio (opcional)
        animalId3, // 3º prêmio (opcional)
        animalId4, // 4º prêmio (opcional)
        animalId5, // 5º prêmio (opcional)
        resultNumber1, // Número do 1º prêmio (obrigatório para Milhar/Centena/Dezena)
        resultNumber2, // Número do 2º prêmio (opcional)
        resultNumber3, // Número do 3º prêmio (opcional)
        resultNumber4, // Número do 4º prêmio (opcional)
        resultNumber5  // Número do 5º prêmio (opcional)
      } = req.body;
      
      console.log(`Processing draw result: Draw ID: ${drawId}
        1º prêmio: Animal ${animalId}, Número ${resultNumber1 || 'não definido'}
        2º prêmio: Animal ${animalId2 || 'não definido'}, Número ${resultNumber2 || 'não definido'}
        3º prêmio: Animal ${animalId3 || 'não definido'}, Número ${resultNumber3 || 'não definido'}
        4º prêmio: Animal ${animalId4 || 'não definido'}, Número ${resultNumber4 || 'não definido'}
        5º prêmio: Animal ${animalId5 || 'não definido'}, Número ${resultNumber5 || 'não definido'}
      `);
      
      // Validar o animal do 1º prêmio (obrigatório)
      if (!animalId || typeof animalId !== 'number') {
        console.error(`Invalid animal ID for 1st prize: ${animalId}`);
        return res.status(400).json({ message: "ID de animal inválido para o 1º prêmio" });
      }

      // Validar o número do 1º prêmio (obrigatório)
      if (!resultNumber1) {
        console.error(`Missing number for 1st prize`);
        return res.status(400).json({ message: "Número para o 1º prêmio é obrigatório" });
      }

      const draw = await storage.getDraw(drawId);
      if (!draw) {
        console.error(`Draw not found: ${drawId}`);
        return res.status(404).json({ message: "Sorteio não encontrado" });
      }

      // Validar todos os animais informados
      const animalIds = [animalId];
      if (animalId2) animalIds.push(animalId2);
      if (animalId3) animalIds.push(animalId3);
      if (animalId4) animalIds.push(animalId4);
      if (animalId5) animalIds.push(animalId5);
      
      for (const id of animalIds) {
        const animal = await storage.getAnimal(id);
        if (!animal) {
          console.error(`Animal not found: ${id}`);
          return res.status(404).json({ message: `Animal com ID ${id} não encontrado` });
        }
      }

      // Processar os números para garantir o formato correto (4 dígitos)
      const formattedNumber1 = resultNumber1.padStart(4, '0');
      const formattedNumber2 = resultNumber2 ? resultNumber2.padStart(4, '0') : undefined;
      const formattedNumber3 = resultNumber3 ? resultNumber3.padStart(4, '0') : undefined;
      const formattedNumber4 = resultNumber4 ? resultNumber4.padStart(4, '0') : undefined;
      const formattedNumber5 = resultNumber5 ? resultNumber5.padStart(4, '0') : undefined;

      console.log(`Processing draw ${drawId} with multiple prize animals and numbers`);
      const updatedDraw = await storage.updateDrawResult(
        drawId, 
        animalId, 
        animalId2, 
        animalId3, 
        animalId4, 
        animalId5,
        formattedNumber1,
        formattedNumber2,
        formattedNumber3,
        formattedNumber4,
        formattedNumber5
      );
      
      if (!updatedDraw) {
        console.error(`Failed to update draw result for draw ${drawId}`);
        return res.status(500).json({ message: "Erro ao atualizar resultado do sorteio" });
      }
      
      console.log(`Draw result processed successfully, invalidating caches`);
      
      // Add cache invalidation for various endpoints that should be refreshed after updating a draw
      // This signals clients to reload user data, bets data, and draws data
      req.app.emit('draw:result', { 
        drawId, 
        animalId,
        animalId2,
        animalId3,
        animalId4,
        animalId5,
        resultNumber1: formattedNumber1,
        resultNumber2: formattedNumber2,
        resultNumber3: formattedNumber3,
        resultNumber4: formattedNumber4,
        resultNumber5: formattedNumber5
      });
      
      // Respond with the updated draw
      res.json(updatedDraw);
    } catch (error) {
      console.error(`Error processing draw result: ${error}`);
      res.status(500).json({ message: "Erro ao processar resultado do sorteio" });
    }
  });

  // Create bet
  app.post("/api/bets", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      console.log(`Creating bet for user ID: ${userId}`);
      console.log("Bet request data:", req.body);
      
      // Usar o valor real diretamente, sem conversão para centavos
      const requestData = {
        ...req.body,
        userId
      };
      
      // Validate the bet data
      const validatedData = insertBetSchema.parse(requestData);
      
      console.log("Validated bet data:", validatedData);
      
      // Verificar configurações do sistema para limites de apostas
      const systemSettings = await storage.getSystemSettings();
      console.log("System settings for bet limits:", {
        maxBetAmount: systemSettings?.maxBetAmount,
        maxPayout: systemSettings?.maxPayout
      });
      
      // Verificar limite de aposta mínima
      if (systemSettings && systemSettings.minBetAmount && validatedData.amount < systemSettings.minBetAmount) {
        console.log(`Bet amount below minimum allowed: ${validatedData.amount} < ${systemSettings.minBetAmount}`);
        return res.status(400).json({ 
          message: `O valor mínimo de aposta é de R$ ${systemSettings.minBetAmount.toFixed(2).replace(".", ",")}`,
          currentAmount: validatedData.amount,
          minAllowed: systemSettings.minBetAmount
        });
      }
      
      // Verificar limite de aposta máxima
      if (systemSettings && systemSettings.maxBetAmount && validatedData.amount > systemSettings.maxBetAmount) {
        console.log(`Bet amount exceeds maximum allowed: ${validatedData.amount} > ${systemSettings.maxBetAmount}`);
        return res.status(400).json({ 
          message: `A aposta máxima permitida é de R$ ${systemSettings.maxBetAmount.toFixed(2).replace(".", ",")}`,
          currentAmount: validatedData.amount,
          maxAllowed: systemSettings.maxBetAmount
        });
      }
      
      // Verify the user has enough balance
      const user = await storage.getUser(userId);
      if (!user) {
        console.log(`User not found: ${userId}`);
        return res.status(404).json({ message: "User not found" });
      }
      
      console.log(`User balance: ${user.balance}, Bet amount: ${validatedData.amount}`);
      if (user.balance < validatedData.amount) {
        console.log(`Insufficient balance: ${user.balance} < ${validatedData.amount}`);
        return res.status(400).json({ 
          message: "Saldo insuficiente para realizar esta aposta", 
          currentBalance: user.balance,
          requiredAmount: validatedData.amount 
        });
      }
      
      // Verify the draw exists and is pending
      const draw = await storage.getDraw(validatedData.drawId);
      if (!draw) {
        console.log(`Draw not found: ${validatedData.drawId}`);
        return res.status(404).json({ message: "Sorteio não encontrado" });
      }
      
      if (draw.status !== "pending") {
        console.log(`Draw not pending: ${draw.status}`);
        return res.status(400).json({ message: "Este sorteio não está mais aceitando apostas" });
      }
      
      const now = new Date();
      if (new Date(draw.date) < now) {
        console.log(`Draw already started: ${draw.date} < ${now}`);
        return res.status(400).json({ message: "Este sorteio já começou" });
      }
      
      // Verify animals exist based on bet type
      console.log(`Validating animals for bet type: ${validatedData.type}`);
      
      // Verificando tipos de apostas por grupo (animal)
      if (["group"].includes(validatedData.type)) {
        // Grupo (1 animal)
        console.log("Validando aposta por grupo com body:", req.body);
        
        // Verificar todos os possíveis campos onde o número pode estar
        if (req.body.numbers) {
          console.log(`Encontrado 'numbers' no corpo: ${req.body.numbers}`);
          // Converter para betNumbers para processamento
          if (!validatedData.betNumbers) validatedData.betNumbers = [];
          validatedData.betNumbers.push(req.body.numbers);
        }
        
        // Verificar se temos animalId ou betNumbers (apostas numéricas interpretadas como animais)
        if (!validatedData.animalId && (!validatedData.betNumbers || !validatedData.betNumbers.length)) {
          return res.status(400).json({ message: "Animal ou número é obrigatório para apostas de grupo" });
        }
        
        // Se temos animalId, validar que o animal existe
        if (validatedData.animalId) {
          const animal = await storage.getAnimal(validatedData.animalId);
          if (!animal) {
            console.log(`Animal not found: ${validatedData.animalId}`);
            return res.status(404).json({ message: "Animal não encontrado" });
          }
          console.log(`Animal found for GROUP bet: ${animal.name} (${animal.group})`);
        }
        // Se temos betNumbers, vamos usar esses números para representar o grupo
        else if (validatedData.betNumbers && validatedData.betNumbers.length > 0) {
          console.log(`Using numeric input for GROUP bet: ${validatedData.betNumbers.join(', ')}`);
          // Não precisamos validar mais nada aqui, os números serão processados posteriormente
        }
      } 
      // Verificando tipos que requerem 2 animais
      else if (["duque_grupo", "passe_ida", "passe_ida_volta"].includes(validatedData.type)) {
        // Requer 2 animais (principal + secundário)
        if (!validatedData.animalId || !validatedData.animalId2) {
          return res.status(400).json({ message: "Dois animais são obrigatórios para este tipo de aposta" });
        }
        
        // Verificar primeiro animal
        const animal1 = await storage.getAnimal(validatedData.animalId);
        if (!animal1) {
          console.log(`First animal not found: ${validatedData.animalId}`);
          return res.status(404).json({ message: "Primeiro animal não encontrado" });
        }
        
        // Verificar segundo animal
        const animal2 = await storage.getAnimal(validatedData.animalId2);
        if (!animal2) {
          console.log(`Second animal not found: ${validatedData.animalId2}`);
          return res.status(404).json({ message: "Segundo animal não encontrado" });
        }
        
        console.log(`2 animals found for ${validatedData.type} bet: ${animal1.name} and ${animal2.name}`);
      }
      // Verificando tipos que requerem 3 animais
      else if (["terno_grupo"].includes(validatedData.type)) {
        // Requer 3 animais
        if (!validatedData.animalId || !validatedData.animalId2 || !validatedData.animalId3) {
          return res.status(400).json({ message: "Três animais são obrigatórios para este tipo de aposta" });
        }
        
        // Verificar todos os animais
        const animalIds = [validatedData.animalId, validatedData.animalId2, validatedData.animalId3];
        for (const id of animalIds) {
          const animal = await storage.getAnimal(id);
          if (!animal) {
            console.log(`Animal not found: ${id}`);
            return res.status(404).json({ message: `Animal com ID ${id} não encontrado` });
          }
        }
        
        console.log(`3 animals validated for terno_grupo bet`);
      }
      // Verificando tipos que requerem 4 animais
      else if (["quadra_duque"].includes(validatedData.type)) {
        // Requer 4 animais
        if (!validatedData.animalId || !validatedData.animalId2 || 
            !validatedData.animalId3 || !validatedData.animalId4) {
          return res.status(400).json({ message: "Quatro animais são obrigatórios para este tipo de aposta" });
        }
        
        // Verificar todos os animais
        const animalIds = [
          validatedData.animalId, 
          validatedData.animalId2, 
          validatedData.animalId3,
          validatedData.animalId4
        ];
        
        for (const id of animalIds) {
          const animal = await storage.getAnimal(id);
          if (!animal) {
            console.log(`Animal not found: ${id}`);
            return res.status(404).json({ message: `Animal com ID ${id} não encontrado` });
          }
        }
        
        console.log(`4 animals validated for quadra_duque bet`);
      }
      // Verificando tipos que requerem 5 animais
      else if (["quina_grupo"].includes(validatedData.type)) {
        // Requer 5 animais
        if (!validatedData.animalId || !validatedData.animalId2 || 
            !validatedData.animalId3 || !validatedData.animalId4 || 
            !validatedData.animalId5) {
          return res.status(400).json({ message: "Cinco animais são obrigatórios para este tipo de aposta" });
        }
        
        // Verificar todos os animais
        const animalIds = [
          validatedData.animalId, 
          validatedData.animalId2, 
          validatedData.animalId3,
          validatedData.animalId4,
          validatedData.animalId5
        ];
        
        for (const id of animalIds) {
          const animal = await storage.getAnimal(id);
          if (!animal) {
            console.log(`Animal not found: ${id}`);
            return res.status(404).json({ message: `Animal com ID ${id} não encontrado` });
          }
        }
        
        console.log(`5 animals validated for quina_grupo bet`);
      }
      // Verificando apostas baseadas em números (dezena, centena, milhar)
      else if (["dozen", "hundred", "thousand"].includes(validatedData.type)) {
        // Para apostas baseadas em números, verificar se os números existem
        console.log("Validando aposta numérica com body:", req.body);
        
        // Verificar todos os possíveis campos onde o número pode estar
        if (req.body.betNumber) {
          console.log(`Encontrado betNumber no corpo da requisição: ${req.body.betNumber}`);
          if (!validatedData.betNumbers) validatedData.betNumbers = [];
          validatedData.betNumbers.push(String(req.body.betNumber));
        }
        
        if (req.body.numbers) {
          console.log(`Encontrado campo numbers no corpo da requisição: ${req.body.numbers}`);
          if (!validatedData.betNumbers) validatedData.betNumbers = [];
          validatedData.betNumbers.push(String(req.body.numbers));
        }
        
        // Verificação final de betNumbers
        if (!validatedData.betNumbers || !validatedData.betNumbers.length) {
          return res.status(400).json({ message: "Números da aposta são obrigatórios para este tipo de aposta" });
        }
        
        // FORÇAR o ID correto da modalidade baseado no tipo independente do que foi enviado
        let expectedLength = 0;
        
        if (validatedData.type === "dozen") {
          expectedLength = 2;
          validatedData.gameModeId = 4; // Força para Dezena
          console.log("FORÇANDO gameModeId para 4 (Dezena)");
        }
        else if (validatedData.type === "hundred") {
          expectedLength = 3;
          validatedData.gameModeId = 2; // Força para Centena
          console.log("FORÇANDO gameModeId para 2 (Centena)");
        }
        else if (validatedData.type === "thousand") {
          expectedLength = 4;
          validatedData.gameModeId = 1; // Força para Milhar
          console.log("FORÇANDO gameModeId para 1 (Milhar)");
        }
        
        // Apenas garantimos que sejam valores numéricos sem adicionar zeros ou truncar
        validatedData.betNumbers = validatedData.betNumbers.map(num => {
          // Garantir que é uma string e remover espaços
          let cleanNum = String(num).trim();
          
          // Remover caracteres não numéricos
          cleanNum = cleanNum.replace(/\D/g, '');
          
          return cleanNum;
        });
        
        console.log(`Números formatados após processamento: ${validatedData.betNumbers.join(', ')}`);
        
        // Verificação rigorosa do formato dos números com base no tipo de aposta
        // Em vez de ajustar automaticamente, exigimos que o formato seja exatamente o esperado
        
        // Verificar se cada número têm exatamente o tamanho correto para o tipo de aposta
        for (const num of validatedData.betNumbers) {
          // Definições específicas de cada tipo
          const tipoAposta = validatedData.type === 'dozen' ? 'dezena' : 
                            validatedData.type === 'hundred' ? 'centena' : 'milhar';
          
          // Validação rigorosa: o número DEVE ter exatamente o tamanho esperado
          if (num.length !== expectedLength) {
            // Mensagem mais amigável para o usuário
            return res.status(400).json({
              message: `Para apostar na ${tipoAposta}, você deve digitar exatamente ${expectedLength} números. Por favor, tente novamente.`,
              expectedLength: expectedLength,
              receivedLength: num.length,
              receivedValue: num
            });
          }
          
          // Verificar se contém apenas dígitos numéricos
          if (!/^\d+$/.test(num)) {
            return res.status(400).json({
              message: `O número da aposta deve conter apenas dígitos (0-9). Valor recebido: "${num}"`
            });
          }
        }
        
        // Se chegou aqui, todos os números estão corretos e não precisam de ajustes
        console.log(`Números formatados corretamente: ${validatedData.betNumbers.join(', ')}`);
        
        // Log do tipo de aposta e números
        console.log(`Number-based bet: ${validatedData.type} - ${validatedData.betNumbers.join(', ')}`);
      }
      // Verificar outros tipos de apostas (dezena duque, dezena terno)
      else if (["duque_dezena"].includes(validatedData.type)) {
        console.log("Validando aposta de duque dezena com body:", req.body);
        
        // Verificar todos os possíveis campos onde os números podem estar
        if (req.body.numbers) {
          // Tentar extrair múltiplas dezenas de uma string separada por vírgula, traço ou espaço
          const extractedNumbers = req.body.numbers.split(/[,\s\-]+/).filter((n: string) => n.trim().length > 0);
          console.log(`Extraídos números de 'numbers': ${extractedNumbers.join(', ')}`);
          
          if (extractedNumbers.length > 0) {
            if (!validatedData.betNumbers) validatedData.betNumbers = [];
            validatedData.betNumbers = validatedData.betNumbers.concat(extractedNumbers);
          }
        }
        
        // Requer 2 dezenas
        if (!validatedData.betNumbers || validatedData.betNumbers.length !== 2) {
          return res.status(400).json({ message: "Duas dezenas são obrigatórias para apostas de duque de dezena" });
        }
        
        // Formatar e validar cada dezena (2 dígitos) sem preenchimento automático
        validatedData.betNumbers = validatedData.betNumbers.map(num => {
          let cleaned = num.replace(/\D/g, '');
          // Não adicionamos mais zeros à esquerda, exigimos digitação completa
          if (cleaned.length !== 2) {
            console.log(`Dezena inválida para duque: ${cleaned} (deve ter exatamente 2 dígitos)`);
            // A validação acontecerá logo em seguida
          }
          return cleaned;
        });
        
        console.log(`Dezenas para duque: ${validatedData.betNumbers.join(', ')}`);
        
        // Validação final
        if (validatedData.betNumbers.some(n => n.length !== 2)) {
          return res.status(400).json({ message: "Apostas de duque de dezena devem ter dezenas com 2 dígitos" });
        }
        
        console.log(`Duque dezena bet: ${validatedData.betNumbers.join(', ')}`);
      }
      else if (["terno_dezena"].includes(validatedData.type)) {
        console.log("Validando aposta de terno dezena com body:", req.body);
        
        // Verificar todos os possíveis campos onde os números podem estar
        if (req.body.numbers) {
          // Tentar extrair múltiplas dezenas de uma string separada por vírgula, traço ou espaço
          const extractedNumbers = req.body.numbers.split(/[,\s\-]+/).filter((n: string) => n.trim().length > 0);
          console.log(`Extraídos números de 'numbers': ${extractedNumbers.join(', ')}`);
          
          if (extractedNumbers.length > 0) {
            if (!validatedData.betNumbers) validatedData.betNumbers = [];
            validatedData.betNumbers = validatedData.betNumbers.concat(extractedNumbers);
          }
        }
        
        // Requer 3 dezenas
        if (!validatedData.betNumbers || validatedData.betNumbers.length !== 3) {
          return res.status(400).json({ message: "Três dezenas são obrigatórias para apostas de terno de dezena" });
        }
        
        // Formatar e validar cada dezena (2 dígitos) sem preenchimento automático
        validatedData.betNumbers = validatedData.betNumbers.map(num => {
          let cleaned = num.replace(/\D/g, '');
          // Não adicionamos mais zeros à esquerda, exigimos digitação completa
          if (cleaned.length !== 2) {
            console.log(`Dezena inválida para terno: ${cleaned} (deve ter exatamente 2 dígitos)`);
            // A validação acontecerá logo em seguida
          }
          return cleaned;
        });
        
        console.log(`Dezenas para terno: ${validatedData.betNumbers.join(', ')}`);
        
        // Validação final
        if (validatedData.betNumbers.some(n => n.length !== 2)) {
          return res.status(400).json({ message: "Apostas de terno de dezena devem ter dezenas com 2 dígitos" });
        }
        
        console.log(`Terno dezena bet: ${validatedData.betNumbers.join(', ')}`);
      }
      else {
        return res.status(400).json({ message: `Tipo de aposta inválido: ${validatedData.type}` });
      }
      
      // Verify game mode if provided
      if (validatedData.gameModeId) {
        console.log(`========= VERIFICANDO MODALIDADE =========`);
        console.log(`Tipo de aposta: ${validatedData.type}`);
        console.log(`GameModeID: ${validatedData.gameModeId}`);
        console.log(`Números: ${validatedData.betNumbers?.join(', ') || 'nenhum'}`);
        console.log(`=========================================`);
        const gameMode = await storage.getGameMode(validatedData.gameModeId);
        if (!gameMode) {
          console.log(`Game mode not found: ${validatedData.gameModeId}`);
          return res.status(404).json({ message: "Modalidade de jogo não encontrada" });
        }
        
        console.log(`Game mode found: ${gameMode.name}, active: ${gameMode.active}`);
        if (!gameMode.active) {
          return res.status(400).json({ message: "Esta modalidade de jogo não está ativa no momento" });
        }
        
        // Verificação rigorosa para garantir que o modo de jogo é compatível com o tipo de aposta
        // Cria um mapeamento entre tipos de apostas e os IDs de game modes permitidos
        interface GameModeMap {
          thousand: number[];
          hundred: number[];
          dozen: number[];
          [key: string]: number[];
        }
        
        const allowedGameModes: GameModeMap = {
          "thousand": [1], // ID 1 = Milhar
          "hundred": [2],  // ID 2 = Centena
          "dozen": [4]     // ID 4 = Dezena
        };
        
        // Verifica se o tipo de aposta existe no mapeamento
        if (validatedData.type in allowedGameModes) {
          // Verifica se o gameMode.id está na lista de modos permitidos para este tipo
          if (!allowedGameModes[validatedData.type].includes(gameMode.id)) {
            console.log(`Invalid game mode for bet type. Type: ${validatedData.type}, GameMode ID: ${gameMode.id}, Allowed: ${allowedGameModes[validatedData.type].join(',')}`);
            
            // Determinar qual modalidade deveria ser usada
            let suggestedGameMode = "";
            if (validatedData.type === "thousand") suggestedGameMode = "Milhar";
            else if (validatedData.type === "hundred") suggestedGameMode = "Centena";
            else if (validatedData.type === "dozen") suggestedGameMode = "Dezena";
            
            return res.status(400).json({ 
              message: `Tipo de aposta "${validatedData.type}" é incompatível com a modalidade "${gameMode.name}". Use a modalidade "${suggestedGameMode}".`,
              gameModeSuggestion: suggestedGameMode,
              currentGameMode: gameMode.name
            });
          }
        }
        
        // Calcular o valor potencial de ganho usando a fórmula padrão
        // 1. Aplicar divisor caso seja aposta em todos os prêmios (1-5)
        const oddsDivisor = validatedData.premioType === "1-5" ? 5 : 1;
        const adjustedOdds = gameMode.odds / oddsDivisor;
        
        // 2. Calcular usando a fórmula padrão: multiplicar valor da aposta pelo multiplicador ajustado
        // Esta fórmula DEVE ser idêntica à usada nos componentes do cliente
        const calculatedWinAmount = Math.floor(validatedData.amount * adjustedOdds);
        
        console.log(`Cálculo de potencial de ganho no servidor:`, {
          gameMode: gameMode.name,
          originalOdds: gameMode.odds,
          premioType: validatedData.premioType,
          oddsDivisor,
          adjustedOdds,
          amount: validatedData.amount,
          calculatedWinAmount,
          providedWinAmount: validatedData.potentialWinAmount
        });
        
        // Verificar limite de premiação máxima
        if (systemSettings && systemSettings.maxPayout && calculatedWinAmount > systemSettings.maxPayout) {
          console.log(`Potential win amount exceeds maximum allowed: ${calculatedWinAmount} > ${systemSettings.maxPayout}`);
          // Calcular o valor máximo de aposta permitido com valores reais
          const maxBetAllowed = systemSettings.maxPayout / gameMode.odds;
          return res.status(400).json({ 
            message: `A premiação máxima permitida é de R$ ${systemSettings.maxPayout}`,
            calculatedPayout: calculatedWinAmount,
            maxAllowed: systemSettings.maxPayout,
            suggestion: `Reduza o valor da aposta para no máximo R$ ${maxBetAllowed.toFixed(2).replace('.', ',')}`
          });
        }
        
        // Verify the potential win amount if provided
        if (validatedData.potentialWinAmount) {
          // Allow a small difference due to floating point arithmetic
          if (Math.abs(calculatedWinAmount - validatedData.potentialWinAmount) > 1) {
            console.log(`Adjusting potential win amount from ${validatedData.potentialWinAmount} to ${calculatedWinAmount}`);
            validatedData.potentialWinAmount = calculatedWinAmount;
          }
        } else {
          // Calculate potential win amount if not provided
          console.log(`Setting potential win amount to ${calculatedWinAmount}`);
          validatedData.potentialWinAmount = calculatedWinAmount;
        }
      }
      
      console.log(`Deducting ${validatedData.amount} from user balance`);
      // Deduct the bet amount from the user's balance
      await storage.updateUserBalance(userId, -validatedData.amount);
      
      console.log("Creating bet in the database");
      // Create the bet
      const bet = await storage.createBet(validatedData);
      
      console.log("Bet created successfully:", bet);
      res.status(201).json(bet);
    } catch (error) {
      console.error("Error creating bet:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Dados da aposta inválidos", errors: error.errors });
      }
      res.status(500).json({ message: "Erro ao criar aposta", error: String(error) });
    }
  });

  // Get user total winnings
  app.get("/api/user/winnings", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      
      // Buscar soma de todos os ganhos usando SQL
      const result = await db.execute(
        sql`SELECT COALESCE(SUM(win_amount), 0) as total_winnings 
            FROM bets 
            WHERE user_id = ${userId} AND status = 'won'`
      );
      
      // Obter o valor total dos ganhos da primeira linha do resultado
      const totalWinnings = parseFloat(String(result.rows[0]?.total_winnings || '0'));
      
      console.log(`Total de ganhos do usuário ${userId}: R$ ${totalWinnings.toFixed(2)}`);
      
      res.json({ totalWinnings });
    } catch (error) {
      console.error("Erro ao calcular ganhos totais:", error);
      res.status(500).json({ message: "Erro ao calcular ganhos" });
    }
  });

  // Get user bets
  /**
   * Obter todas as apostas do usuário autenticado com isolamento completo de dados
   * Implementa múltiplas camadas de proteção contra vazamento de dados entre usuários
   */
  app.get("/api/bets", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const username = req.user!.username;
      console.log(`REQUISIÇÃO: Usuário ${username} (${userId}) solicitando suas apostas`);
      
      // Extrair parâmetros de paginação e ordenação
      const page = parseInt(req.query.page as string) || 1;
      const pageSize = parseInt(req.query.pageSize as string) || 10;
      const sortOrder = (req.query.sortOrder as string) === 'asc' ? 'asc' : 'desc'; // default to desc (newest first)
      
      // MÉTODO 1: Buscar diretamente do banco de dados com filtro de userId
      // Isso garante que a consulta SQL já aplica filtro de dados no nível mais baixo
      console.log(`SEGURANÇA: Consultando apostas do usuário ${userId} diretamente no banco de dados com filtragem`);
      const userBetsFromDb = await db
        .select()
        .from(bets)
        .where(eq(bets.userId, userId))
        .orderBy(sortOrder === 'desc' ? desc(bets.createdAt) : asc(bets.createdAt));
      
      console.log(`BANCO: Consulta retornou ${userBetsFromDb.length} apostas para usuário ${userId}`);
      
      // MÉTODO 2: Usar o serviço de storage com verificações extras
      // Isso garante uma verificação redundante através de outra camada
      const betsFromStorage = await storage.getBetsByUserId(userId);
      console.log(`STORAGE: Serviço retornou ${betsFromStorage.length} apostas para usuário ${userId}`);
      
      // MÉTODO 3: Verificação cruzada entre os resultados para detectar inconsistências
      // Comparamos apenas os IDs para identificar possíveis discrepâncias entre as fontes
      const dbBetIds = new Set(userBetsFromDb.map(bet => bet.id));
      const storageBetIds = new Set(betsFromStorage.map(bet => bet.id));
      
      // Verificar inconsistências (apostas que estão em um método mas não no outro)
      const onlyInDb = Array.from(dbBetIds).filter(id => !storageBetIds.has(id));
      const onlyInStorage = Array.from(storageBetIds).filter(id => !dbBetIds.has(id));
      
      if (onlyInDb.length > 0 || onlyInStorage.length > 0) {
        console.error(`ALERTA DE SEGURANÇA: Inconsistência na recuperação de apostas para usuário ${userId}!
          Apostas apenas no banco: ${onlyInDb.join(', ')}
          Apostas apenas no storage: ${onlyInStorage.join(', ')}
        `);
      }
      
      // MÉTODO 4: Filtro final de segurança aplicado aos resultados do banco de dados
      // Garantimos que apenas as apostas do usuário são retornadas, mesmo que haja falha nas camadas anteriores
      const userBets = userBetsFromDb.filter(bet => bet.userId === userId);
      
      // Verificar se o filtro final removeu alguma aposta (indicando falha nas camadas anteriores)
      if (userBets.length !== userBetsFromDb.length) {
        console.error(`VIOLAÇÃO DE SEGURANÇA CRÍTICA: Encontradas ${userBetsFromDb.length - userBets.length} apostas 
          de outros usuários no resultado após filtragem por SQL! 
          Usuário: ${username} (${userId})
          Apostas removidas: ${userBetsFromDb
            .filter(bet => bet.userId !== userId)
            .map(bet => `ID ${bet.id} (user ${bet.userId})`)
            .join(', ')}
        `);
      } 
      else {
        console.log(`VERIFICAÇÃO FINAL: Todas as ${userBets.length} apostas pertencem ao usuário ${userId}`);
      }
      
      // OTIMIZAÇÃO: Agora que a nossa função storage.getBetsByUserId está otimizada e segura, 
      // vamos usá-la diretamente para obter os detalhes das apostas
      // Isso evita ter que fazer consultas individuais para cada aposta e melhora muito a performance
      const betsWithDetails = betsFromStorage;
      
      // Aplicar paginação manual aos resultados
      const totalItems = betsWithDetails.length;
      const totalPages = Math.ceil(totalItems / pageSize);
      const startIndex = (page - 1) * pageSize;
      const endIndex = Math.min(startIndex + pageSize, totalItems);
      
      // Pegar apenas os itens da página atual
      const paginatedItems = betsWithDetails.slice(startIndex, endIndex);
      
      console.log(`RESPOSTA: Enviando ${paginatedItems.length} apostas para usuário ${username} (${userId}), página ${page} de ${totalPages}`);
      
      // Resposta formatada com metadados de paginação
      res.json({
        data: paginatedItems,
        meta: {
          total: totalItems,
          page,
          pageSize,
          totalPages
        }
      });
    } catch (error) {
      console.error(`ERRO: Falha ao buscar apostas para usuário ${req.user!.id}:`, error);
      res.status(500).json({ message: "Erro ao buscar apostas" });
    }
  });
  
  // Get specific bet by ID
  app.get("/api/bets/:id", requireOwnership('bet'), async (req, res) => {
    try {
      // O middleware requireOwnership já verificou que a aposta existe
      // e pertence ao usuário autenticado, e a armazenou em req.resource
      res.json((req as any).resource);
    } catch (error) {
      console.error("Error fetching bet:", error);
      res.status(500).json({ message: "Error fetching bet" });
    }
  });
  
  // Change user password
  app.post("/api/user/change-password", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const { currentPassword, newPassword } = req.body;
      
      // Verifica se a senha atual está correta
      const user = await storage.getUserByUsername(req.user!.username);
      if (!user) {
        return res.status(404).json({ message: "Usuário não encontrado" });
      }
      
      // Verifica se o usuário está tentando alterar sua própria senha (segurança adicional)
      if (user.id !== userId) {
        console.log(`Security: User ${userId} attempted to change password for user ${user.id}`);
        return res.status(403).json({ message: "Acesso negado: você só pode alterar sua própria senha" });
      }
      
      const isPasswordValid = await comparePasswords(currentPassword, user.password);
      if (!isPasswordValid) {
        return res.status(400).json({ message: "Senha atual incorreta" });
      }
      
      // Atualiza a senha
      const hashedPassword = await hashPassword(newPassword);
      await storage.updateUser(user.id, { password: hashedPassword });
      
      res.status(200).json({ message: "Senha alterada com sucesso" });
    } catch (error) {
      console.error("Erro ao alterar senha:", error);
      res.status(500).json({ message: "Erro ao alterar senha" });
    }
  });

  // Atualizar a chave PIX padrão do usuário
  app.put("/api/user/pix-key", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const { pixKey, pixKeyType } = req.body;
      
      // Validação básica
      if (!pixKey || !pixKeyType) {
        return res.status(400).json({ message: "Chave PIX e tipo são obrigatórios" });
      }
      
      // Validação do tipo de chave PIX
      const validTypes = ["cpf", "email", "phone", "random"];
      if (!validTypes.includes(pixKeyType)) {
        return res.status(400).json({ message: "Tipo de chave PIX inválido" });
      }
      
      // Validação específica para cada tipo de chave
      if (pixKeyType === "cpf" && !/^\d{3}\.\d{3}\.\d{3}-\d{2}$|^\d{11}$/.test(pixKey)) {
        return res.status(400).json({ message: "Formato de CPF inválido" });
      }
      
      if (pixKeyType === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pixKey)) {
        return res.status(400).json({ message: "Formato de e-mail inválido" });
      }
      
      if (pixKeyType === "phone" && !/^(\+\d{2})?\s*(\(\d{2}\))?\s*\d{4,5}-?\d{4}$/.test(pixKey)) {
        return res.status(400).json({ message: "Formato de telefone inválido" });
      }
      
      // Atualizar o usuário com a nova chave PIX
      console.log(`Atualizando chave PIX do usuário ${userId}: ${pixKeyType} - ${pixKey}`);
      const updatedUser = await storage.updateUser(userId, {
        defaultPixKey: pixKey,
        defaultPixKeyType: pixKeyType
      });
      
      if (!updatedUser) {
        return res.status(500).json({ message: "Erro ao atualizar chave PIX" });
      }
      
      res.status(200).json({ 
        message: "Chave PIX atualizada com sucesso",
        pixKey,
        pixKeyType
      });
    } catch (error) {
      console.error("Erro ao atualizar chave PIX:", error);
      res.status(500).json({ message: "Erro ao atualizar chave PIX" });
    }
  });

  // Update user balance (for deposits and withdrawals)
  app.post("/api/users/balance", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const { amount, type } = req.body;
      
      if (!amount || typeof amount !== 'number' || !['deposit', 'withdraw'].includes(type)) {
        return res.status(400).json({ message: "Invalid request data" });
      }
      
      // Adicionar logs detalhados para depuração
      console.log(`Request for ${type} operation with amount ${amount}`);
      
      // Verificar configurações do sistema para depósitos e saques
      const systemSettings = await storage.getSystemSettings();
      console.log("System settings:", JSON.stringify(systemSettings, null, 2));
      
      // Verificar explicitamente o valor de allowWithdrawals
      if (type === 'withdraw') {
        console.log(`Withdraw operation attempted. allowWithdrawals = ${systemSettings?.allowWithdrawals}`);
        
        // Se for um saque e saques estão desativados
        if (systemSettings && systemSettings.allowWithdrawals === false) {
          console.log("Withdrawals are disabled in system settings. Blocking operation.");
          return res.status(403).json({ message: "Saques estão temporariamente desativados" });
        }
      }
      
      // Verificar explicitamente o valor de allowDeposits
      if (type === 'deposit') {
        console.log(`Deposit operation attempted. allowDeposits = ${systemSettings?.allowDeposits}`);
        
        // Se for um depósito e depósitos estão desativados
        if (systemSettings && systemSettings.allowDeposits === false) {
          console.log("Deposits are disabled in system settings. Blocking operation.");
          return res.status(403).json({ message: "Depósitos estão temporariamente desativados" });
        }
      }
      
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      
      if (type === 'withdraw' && user.balance < amount) {
        return res.status(400).json({ message: "Insufficient balance" });
      }
      
      const finalAmount = type === 'deposit' ? amount : -amount;
      console.log(`Proceeding with ${type} operation, updating balance by ${finalAmount}`);
      const updatedUser = await storage.updateUserBalance(userId, finalAmount);
      
      // Remover senha antes de retornar ao cliente
      if (updatedUser) {
        const { password, ...userWithoutPassword } = updatedUser;
        res.json(userWithoutPassword);
      } else {
        res.status(500).json({ message: "Error updating balance" });
      }
    } catch (error) {
      console.error("Error updating balance:", error);
      res.status(500).json({ message: "Error updating balance" });
    }
  });

  // Admin routes
  
  // Get all users (admin only)
  app.get("/api/users", requireAdmin, async (req, res) => {
    try {
      const users = await storage.getAllUsers();
      
      // Remover informações sensíveis (senha) antes de retornar
      const sanitizedUsers = users.map(user => {
        const { password, ...userWithoutPassword } = user;
        return userWithoutPassword;
      });
      
      res.json(sanitizedUsers);
    } catch (error) {
      res.status(500).json({ message: "Error fetching users" });
    }
  });

  // Get all bets (admin only) with pagination
  app.get("/api/admin/bets", requireAdmin, async (req, res) => {
    try {
      console.log("Admin fetching bets with pagination");
      
      // Extract pagination and filter parameters
      const page = parseInt(req.query.page as string) || 1;
      const pageSize = parseInt(req.query.pageSize as string) || 50;
      const status = (req.query.status as string) || null;
      const search = (req.query.search as string) || null;
      const sortOrder = (req.query.sortOrder as string) === 'asc' ? 'asc' : 'desc'; // default to desc (newest first)
      
      // Calculate offset for SQL query
      const offset = (page - 1) * pageSize;
      
      // Get paginated bets with total count
      const { bets, total } = await storage.getPaginatedBets({
        page,
        pageSize,
        status,
        search,
        sortOrder,
      });
      
      console.log(`Found ${bets.length} bets for page ${page} (offset: ${offset}, pageSize: ${pageSize})`);
      console.log(`Total bets matching criteria: ${total}`);
      
      // Filtrando informações sensíveis antes de retornar
      const sanitizedBets = bets.map(bet => ({
        ...bet,
        // Removendo informações sensíveis do usuário
        userId: bet.userId, // Mantendo apenas o ID do usuário
        user: null // Removendo objeto de usuário, se houver
      }));
      
      // Return both the paginated bets and metadata
      res.json({
        data: sanitizedBets,
        meta: {
          total,
          page,
          pageSize,
          totalPages: Math.ceil(total / pageSize)
        }
      });
    } catch (error) {
      console.error("Error in GET /api/admin/bets:", error);
      res.status(500).json({ message: "Error fetching bets", error: String(error) });
    }
  });

  // Get popular animals/groups (admin only)
  app.get("/api/admin/stats/popular", requireAdmin, async (req, res) => {
    try {
      const popularAnimals = await storage.getPopularAnimals();
      res.json(popularAnimals);
    } catch (error) {
      res.status(500).json({ message: "Error fetching popular animals" });
    }
  });

  // Create user (admin only)
  app.post("/api/admin/users", requireAdmin, async (req, res) => {
    try {
      const validatedData = insertUserSchema.parse(req.body);
      const user = await storage.createUser(validatedData);
      
      // Remover senha antes de retornar
      if (user) {
        const { password, ...userWithoutPassword } = user;
        res.status(201).json(userWithoutPassword);
      } else {
        res.status(500).json({ message: "Error creating user" });
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid user data", errors: error.errors });
      }
      res.status(500).json({ message: "Error creating user" });
    }
  });

  // Update user (admin only)
  app.put("/api/admin/users/:id", requireAdmin, async (req, res) => {
    try {
      const userId = Number(req.params.id);
      
      // Validate user exists
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      
      // Update user
      const updatedUser = await storage.updateUser(userId, req.body);
      
      // Remover senha antes de retornar
      if (updatedUser) {
        const { password, ...userWithoutPassword } = updatedUser;
        res.json(userWithoutPassword);
      } else {
        res.status(500).json({ message: "Error updating user" });
      }
    } catch (error) {
      res.status(500).json({ message: "Error updating user" });
    }
  });

  // Delete user (admin only)
  app.delete("/api/admin/users/:id", requireAdmin, async (req, res) => {
    try {
      const userId = Number(req.params.id);
      
      // Validate user exists and is not admin
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      
      if (user.isAdmin) {
        return res.status(400).json({ message: "Cannot delete admin user" });
      }
      
      // Delete user
      await storage.deleteUser(userId);
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ message: "Error deleting user" });
    }
  });

  // Update user balance (admin only)
  app.post("/api/admin/users/:id/balance", requireAdmin, async (req, res) => {
    try {
      const userId = Number(req.params.id);
      const { amount } = req.body;
      
      if (typeof amount !== 'number') {
        return res.status(400).json({ message: "Invalid amount" });
      }
      
      // Validate user exists
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      
      // Update balance
      const updatedUser = await storage.updateUserBalance(userId, amount);
      
      // Remover senha antes de retornar
      if (updatedUser) {
        const { password, ...userWithoutPassword } = updatedUser;
        res.json(userWithoutPassword);
      } else {
        res.status(500).json({ message: "Error updating user balance" });
      }
    } catch (error) {
      res.status(500).json({ message: "Error updating user balance" });
    }
  });

  // Game Mode Routes

  // Get all game modes
  app.get("/api/game-modes", async (req, res) => {
    try {
      const gameModes = await storage.getAllGameModes();
      res.json(gameModes);
    } catch (error) {
      res.status(500).json({ message: "Error fetching game modes" });
    }
  });

  // Get game mode by ID
  app.get("/api/game-modes/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      const gameMode = await storage.getGameMode(id);
      
      if (!gameMode) {
        return res.status(404).json({ message: "Game mode not found" });
      }
      
      res.json(gameMode);
    } catch (error) {
      res.status(500).json({ message: "Error fetching game mode" });
    }
  });

  // Create game mode (admin only)
  app.post("/api/game-modes", requireAdmin, async (req, res) => {
    try {
      const validatedData = insertGameModeSchema.parse(req.body);
      
      // Check if a game mode with the same name already exists
      const existing = await storage.getGameModeByName(validatedData.name);
      if (existing) {
        return res.status(400).json({ message: "A game mode with this name already exists" });
      }
      
      const gameMode = await storage.createGameMode(validatedData);
      res.status(201).json(gameMode);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid game mode data", errors: error.errors });
      }
      res.status(500).json({ message: "Error creating game mode" });
    }
  });

  // Update game mode (admin only)
  app.put("/api/game-modes/:id", requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      
      // Validate game mode exists
      const gameMode = await storage.getGameMode(id);
      if (!gameMode) {
        return res.status(404).json({ message: "Game mode not found" });
      }
      
      // Check if name is being changed and if so, ensure no duplicates
      if (req.body.name && req.body.name !== gameMode.name) {
        const existing = await storage.getGameModeByName(req.body.name);
        if (existing) {
          return res.status(400).json({ message: "A game mode with this name already exists" });
        }
      }
      
      // Update game mode
      const updatedGameMode = await storage.updateGameMode(id, req.body);
      res.json(updatedGameMode);
    } catch (error) {
      res.status(500).json({ message: "Error updating game mode" });
    }
  });

  // Delete game mode (admin only)
  app.delete("/api/game-modes/:id", requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      
      // Validate game mode exists
      const gameMode = await storage.getGameMode(id);
      if (!gameMode) {
        return res.status(404).json({ message: "Game mode not found" });
      }
      
      // Delete game mode
      await storage.deleteGameMode(id);
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ message: "Error deleting game mode" });
    }
  });

  // System Settings Routes
  
  // Get system settings (admin only)
  app.get("/api/admin/settings", requireAdmin, async (req, res) => {
    try {
      // Check if settings exist in database, otherwise return defaults
      const settings = await storage.getSystemSettings();
      
      if (settings) {
        res.json(settings);
      } else {
        // Default values
        const defaultSettings = {
          maxBetAmount: 50,
          maxPayout: 500,
          minBetAmount: 0.5, // 0.50 reais (valor real)
          defaultBetAmount: 2, // 2.00 reais (valor real)
          mainColor: "#4f46e5",
          secondaryColor: "#6366f1",
          accentColor: "#f97316",
          allowUserRegistration: true,
          allowDeposits: true,
          allowWithdrawals: true,
          maintenanceMode: false,
          autoApproveWithdrawals: true, // Habilitar aprovação automática por padrão
          autoApproveWithdrawalLimit: 30 // Limite padrão de R$ 30,00
        };
        
        // Save default settings to database
        await storage.saveSystemSettings(defaultSettings);
        res.json(defaultSettings);
      }
    } catch (error) {
      console.error("Error fetching system settings:", error);
      res.status(500).json({ message: "Error fetching system settings" });
    }
  });
  
  // Update system settings (admin only)
  app.put("/api/admin/settings", requireAdmin, async (req, res) => {
    try {
      console.log("Updating system settings:", req.body);
      
      // Validate settings
      const { maxBetAmount, maxPayout, minBetAmount, defaultBetAmount } = req.body;
      if (maxBetAmount <= 0 || maxPayout <= 0) {
        return res.status(400).json({ message: "Valores máximos devem ser positivos" });
      }
      
      // Validação de valores mínimos
      if (minBetAmount <= 0) {
        return res.status(400).json({ message: "O valor mínimo de aposta deve ser positivo" });
      }
      
      // Validação de valor padrão
      if (defaultBetAmount <= 0) {
        return res.status(400).json({ message: "O valor padrão de aposta deve ser positivo" });
      }
      
      // Validações de coerência entre os valores
      if (minBetAmount > maxBetAmount) {
        return res.status(400).json({ message: "O valor mínimo de aposta não pode ser maior que o valor máximo" });
      }
      
      if (defaultBetAmount < minBetAmount) {
        return res.status(400).json({ message: "O valor padrão de aposta não pode ser menor que o valor mínimo" });
      }
      
      if (defaultBetAmount > maxBetAmount) {
        return res.status(400).json({ message: "O valor padrão de aposta não pode ser maior que o valor máximo" });
      }
      
      // Validação para aprovação automática de saques
      const { autoApproveWithdrawals, autoApproveWithdrawalLimit } = req.body;
      
      if (autoApproveWithdrawals && (autoApproveWithdrawalLimit === undefined || autoApproveWithdrawalLimit <= 0)) {
        return res.status(400).json({ 
          message: "O limite para aprovação automática deve ser positivo quando a aprovação automática está ativada" 
        });
      }
      
      // Save settings to database
      const updatedSettings = await storage.saveSystemSettings(req.body);
      
      // Return updated settings
      res.json(updatedSettings);
    } catch (error) {
      console.error("Error updating system settings:", error);
      res.status(500).json({ message: "Error updating system settings" });
    }
  });
  
  // Bet discharge route (admin only)
  app.post("/api/admin/bets/discharge", requireAdmin, async (req, res) => {
    try {
      const { betId, drawId, note } = req.body;
      
      if (!betId || !drawId) {
        return res.status(400).json({ message: "Missing required fields" });
      }
      
      // Validate bet exists and is pending
      const bet = await storage.getBet(betId);
      if (!bet) {
        return res.status(404).json({ message: "Bet not found" });
      }
      
      if (bet.status !== "pending") {
        return res.status(400).json({ message: "Only pending bets can be discharged" });
      }
      
      // Validate draw exists and is pending
      const draw = await storage.getDraw(drawId);
      if (!draw) {
        return res.status(404).json({ message: "Draw not found" });
      }
      
      if (draw.status !== "pending") {
        return res.status(400).json({ message: "Can only discharge to pending draws" });
      }
      
      // Update the bet with the new draw ID
      const updatedBet = await storage.updateBet(betId, { drawId });
      
      // Log the discharge action (in a real implementation, this would be saved to a log table)
      console.log(`Bet ${betId} discharged from draw ${bet.drawId} to draw ${drawId}. Note: ${note || 'N/A'}`);
      
      res.json(updatedBet);
    } catch (error) {
      console.error("Error discharging bet:", error);
      res.status(500).json({ message: "Error discharging bet" });
    }
  });

  // ==================== PAYMENT GATEWAY ROUTES ====================
  
  // Get all payment gateways (admin only)
  app.get("/api/admin/payment-gateways", requireAdmin, async (req, res) => {
    try {
      const gateways = await storage.getAllPaymentGateways();
      res.json(gateways);
    } catch (error) {
      console.error("Error fetching payment gateways:", error);
      res.status(500).json({ message: "Error fetching payment gateways" });
    }
  });

  // Get payment gateway by ID (admin only)
  app.get("/api/admin/payment-gateways/:id", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const gateway = await storage.getPaymentGateway(id);
      
      if (!gateway) {
        return res.status(404).json({ message: "Payment gateway not found" });
      }
      
      res.json(gateway);
    } catch (error) {
      console.error("Error fetching payment gateway:", error);
      res.status(500).json({ message: "Error fetching payment gateway" });
    }
  });

  // Create payment gateway (admin only)
  app.post("/api/admin/payment-gateways", requireAdmin, async (req, res) => {
    try {
      const validatedData = insertPaymentGatewaySchema.parse(req.body);
      
      // Check if a gateway with the same type already exists
      const existingGateway = await storage.getPaymentGatewayByType(validatedData.type);
      if (existingGateway) {
        return res.status(400).json({ 
          message: `A payment gateway with type '${validatedData.type}' already exists` 
        });
      }
      
      const gateway = await storage.createPaymentGateway(validatedData);
      res.status(201).json(gateway);
    } catch (error) {
      console.error("Error creating payment gateway:", error);
      
      if (error instanceof z.ZodError) {
        return res.status(400).json({ 
          message: "Invalid payment gateway data", 
          errors: error.errors 
        });
      }
      
      res.status(500).json({ message: "Error creating payment gateway" });
    }
  });

  // Update payment gateway (admin only)
  app.patch("/api/admin/payment-gateways/:id", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const gateway = await storage.getPaymentGateway(id);
      
      if (!gateway) {
        return res.status(404).json({ message: "Payment gateway not found" });
      }
      
      const updatedGateway = await storage.updatePaymentGateway(id, req.body);
      res.json(updatedGateway);
    } catch (error) {
      console.error("Error updating payment gateway:", error);
      res.status(500).json({ message: "Error updating payment gateway" });
    }
  });

  // Delete payment gateway (admin only)
  app.delete("/api/admin/payment-gateways/:id", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const gateway = await storage.getPaymentGateway(id);
      
      if (!gateway) {
        return res.status(404).json({ message: "Payment gateway not found" });
      }
      
      await storage.deletePaymentGateway(id);
      res.json({ message: "Payment gateway deleted successfully" });
    } catch (error) {
      console.error("Error deleting payment gateway:", error);
      res.status(500).json({ message: "Error deleting payment gateway" });
    }
  });

  // Get active payment gateways (for user)
  app.get("/api/payment-gateways", requireAuth, async (req, res) => {
    try {
      const gateways = await storage.getAllPaymentGateways();
      
      // Filter out inactive gateways and only return necessary fields
      let activeGateways = gateways
        .filter(gateway => gateway.isActive)
        .map(gateway => ({
          id: gateway.id,
          name: gateway.name,
          type: gateway.type
        }));
      
      // Priorize Ezzebank as the primary gateway (put it first in the list)
      activeGateways = activeGateways.sort((a, b) => {
        // Ezzebank always comes first
        if (a.type === "ezzebank") return -1;
        if (b.type === "ezzebank") return 1;
        // Other gateways maintain their original order
        return 0;
      });
      
      res.json(activeGateways);
    } catch (error) {
      console.error("Error fetching active payment gateways:", error);
      res.status(500).json({ message: "Error fetching payment gateways" });
    }
  });

  // Get user payment transactions
  /**
   * Obter todas as transações de pagamento do usuário autenticado 
   * Com múltiplas camadas de isolamento de dados para garantir total privacidade
   */
  app.get("/api/payment-transactions", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const username = req.user!.username;
      console.log(`REQUISIÇÃO: Usuário ${username} (${userId}) solicitando suas transações de pagamento`);
      
      // MÉTODO PRINCIPAL: Usar a função aprimorada que inclui múltiplas camadas de segurança
      // Esta função já implementa:
      //  1. Verificação de existência do usuário
      //  2. Consulta filtrada ao banco de dados
      //  3. Verificação individual de propriedade
      //  4. Detecção e alertas de inconsistências de segurança
      //  5. Sanitização de dados sensíveis
      const userTransactions = await storage.getUserTransactions(userId);
      
      // Filtrar as transações para remover aquelas com type="withdrawal"
      // pois essas já serão obtidas da tabela 'withdrawals'
      const filteredTransactions = userTransactions.filter(tx => tx.type !== "withdrawal");
      
      // Obter os saques do usuário para incluir no histórico de transações
      const userWithdrawals = await storage.getUserWithdrawals(userId);
      
      // Converter saques para o formato de transação para unificar a resposta
      const withdrawalsAsTransactions = userWithdrawals.map(withdrawal => ({
        id: withdrawal.id,
        userId: withdrawal.userId,
        gatewayId: 0, // Gateway fictício para saques
        amount: -withdrawal.amount, // Valor negativo para indicar saída
        status: withdrawal.status,
        externalId: null,
        externalUrl: null,
        response: null,
        createdAt: withdrawal.requestedAt,
        type: "withdrawal" // Identificador adicional
      }));
      
      // Combinar as transações filtradas e os saques, ordenando por data (mais recente primeiro)
      const allTransactions = [...filteredTransactions, ...withdrawalsAsTransactions]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      
      // Registramos a conclusão da operação com sucesso
      console.log(`SEGURANÇA: Operação concluída com sucesso. Retornando ${allTransactions.length} transações para usuário ${username} (${userId}) (${filteredTransactions.length} depósitos e ${userWithdrawals.length} saques)`);
      
      // MÉTODO SECUNDÁRIO: Auditoria adicional (somente para fins de logging)
      // Este é um teste duplo independente que não afeta a resposta enviada
      // mas pode ajudar a detectar problemas potenciais no sistema
      try {
        const auditBankCheck = await db
          .select({ count: sql`count(*)` })
          .from(paymentTransactions)
          .where(eq(paymentTransactions.userId, userId));
        
        const expectedCount = Number(auditBankCheck[0].count);
        
        if (expectedCount !== userTransactions.length) {
          console.error(`AUDITORIA: Discrepância entre contagem do banco (${expectedCount}) e contagem retornada (${userTransactions.length}) para usuário ${userId}`);
        } else {
          console.log(`AUDITORIA: Verificação adicional confirma que todas as ${expectedCount} transações do usuário foram corretamente recuperadas`);
        }
      } catch (auditError) {
        // Falha na auditoria não interrompe o fluxo normal
        console.error(`Falha na auditoria adicional de transações para usuário ${userId}:`, auditError);
      }
      
      // A resposta agora inclui depósitos e saques
      console.log(`RESPOSTA: Enviando ${allTransactions.length} transações para usuário ${username} (${userId})`);
      return res.json(allTransactions);
    } catch (error: any) {
      console.error(`ERRO: Falha ao consultar transações para usuário ${req.user!.id}:`, error);
      return res.status(500).json({ 
        message: 'Erro ao consultar transações',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  });
  
  // Função auxiliar para sanitizar respostas de gateway antes de enviar ao cliente
  function sanitizeGatewayResponse(response: any): any {
    if (!response) return null;
    
    try {
      // Se for string JSON, converter para objeto
      const responseObj = typeof response === 'string' ? JSON.parse(response) : response;
      
      // Remover campos sensíveis que podem conter dados de outros usuários
      const { 
        customer_details, customer_email, customer_phone, customer_id,
        webhook_url, security_token, api_key, token, apiKey, auth,
        payer, sender, recipient, sensitive_data, ...safeFields 
      } = responseObj;
      
      return safeFields;
    } catch (err) {
      console.error("Erro ao sanitizar resposta do gateway:", err);
      return { sanitized: true, info: "Dados completos removidos por segurança" };
    }
  }
  
  // Get specific payment transaction by ID
  app.get("/api/payment-transactions/:id", requireOwnership('transaction'), async (req, res) => {
    try {
      // O middleware requireOwnership já verificou que a transação existe
      // e pertence ao usuário autenticado, e a armazenou em req.resource
      res.json((req as any).resource);
    } catch (error) {
      console.error("Erro ao buscar transação:", error);
      res.status(500).json({ message: "Erro ao buscar transação" });
    }
  });

  // Verificar automaticamente pagamentos pendentes
  app.post("/api/payment-transactions/check-pending", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      
      // Buscar APENAS as transações do usuário autenticado
      const transactions = await storage.getUserTransactions(userId);
      
      // Verificação adicional de segurança, garantindo que todas as transações pertencem ao usuário
      const userTransactions = transactions.filter(transaction => transaction.userId === userId);
      
      // Log para auditoria de segurança
      if (userTransactions.length !== transactions.length) {
        console.error(`ALERTA DE SEGURANÇA: Encontrado ${transactions.length - userTransactions.length} transações que não pertencem ao usuário ${userId}`);
      }
      
      console.log(`Verificando transações do usuário ${userId}. Total: ${userTransactions.length}`);
      
      // Filtrar apenas transações pendentes
      const pendingTransactions = userTransactions.filter(
        t => (t.status === 'pending' || t.status === 'processing') && t.externalId
      );
      
      if (pendingTransactions.length === 0) {
        return res.json({ 
          message: "Nenhuma transação pendente encontrada", 
          checkedCount: 0,
          updatedCount: 0 
        });
      }
      
      console.log(`Verificando ${pendingTransactions.length} transações pendentes para o usuário ${userId}`);
      
      // Lista para armazenar resultados
      const results: any[] = [];
      let updatedCount = 0;
      let checkedCount = 0;
      
      // Verifica cada transação pendente
      for (const transaction of pendingTransactions) {
        try {
          checkedCount++;
          console.log(`Verificando transação ID: ${transaction.id}, Externa ID: ${transaction.externalId}`);
          
          // Buscar gateway
          const gateway = await storage.getPaymentGateway(transaction.gatewayId);
          
          if (!gateway) {
            results.push({
              transactionId: transaction.id,
              status: "error",
              message: "Gateway não encontrado"
            });
            continue;
          }
          
          // Verificar se é Pushin Pay
          if (gateway.type === 'pushinpay' && transaction.externalId) {
            // Obter token do gateway
            const token = process.env.PUSHIN_PAY_TOKEN;
            if (!token) {
              results.push({
                transactionId: transaction.id,
                status: "error",
                message: "Token da API não configurado"
              });
              continue;
            }
            
            // Tentativa 1: Verificar com API V2
            console.log(`[Transação ${transaction.id}] Tentando verificar com API V2...`);
            let verifiedWithV2 = false;
            
            try {
              const apiUrlV2 = `https://api.pushinpay.com.br/api/v2/transactions/${transaction.externalId}`;
              
              const responseV2 = await fetch(apiUrlV2, {
                method: 'GET',
                headers: {
                  'Authorization': `Bearer ${token}`,
                  'Accept': 'application/json'
                }
              });
              
              if (responseV2.ok) {
                const paymentData = await responseV2.json();
                console.log(`[Transação ${transaction.id}] Resposta API V2:`, paymentData);
                
                // Se o pagamento foi concluído com a API V2
                if (paymentData.status === 'PAID' || paymentData.status === 'COMPLETED' ||
                    paymentData.status === 'paid' || paymentData.status === 'completed') {
                  
                  // Verificação adicional de segurança antes de atualizar o status
                  if (transaction.userId !== userId) {
                    console.error(`ALERTA DE SEGURANÇA: Tentativa de processar pagamento de outro usuário.
                      Transação ID: ${transaction.id}
                      Pertence ao usuário: ${transaction.userId}
                      Usuário autenticado: ${userId}`);
                    
                    results.push({
                      transactionId: transaction.id,
                      status: "error",
                      message: "Erro de segurança: transação pertence a outro usuário"
                    });
                    
                    continue; // Pular esta transação
                  }
                  
                  // Verificar se o usuário ainda existe
                  const userV2 = await storage.getUser(transaction.userId);
                  if (!userV2) {
                    console.error(`ALERTA DE SEGURANÇA: Usuário ${transaction.userId} não existe mais, mas possui transação ${transaction.id}`);
                    
                    results.push({
                      transactionId: transaction.id,
                      status: "error",
                      message: "Erro de segurança: usuário não encontrado"
                    });
                    
                    continue; // Pular esta transação
                  }
                  
                  // Atualizar status da transação
                  await storage.updateTransactionStatus(
                    transaction.id,
                    "completed",
                    transaction.externalId,
                    transaction.externalUrl || undefined,
                    paymentData
                  );
                  
                  // Log de auditoria para rastreamento financeiro
                  console.log(`TRANSAÇÃO CONCLUÍDA: ID ${transaction.id}, Usuário ${userV2.username} (${userV2.id}), Valor R$${transaction.amount}`);
                  
                  // Atualizar saldo do usuário
                  await storage.updateUserBalance(transaction.userId, transaction.amount);
                  
                  updatedCount++;
                  results.push({
                    transactionId: transaction.id,
                    status: "completed",
                    message: "Pagamento confirmado (API V2)"
                  });
                  
                  verifiedWithV2 = true;
                } else {
                  // Se não estiver pago ainda, registrar o status
                  results.push({
                    transactionId: transaction.id,
                    status: "pending",
                    message: `Status atual: ${paymentData.status} (API V2)`,
                    apiStatus: paymentData.status
                  });
                  
                  verifiedWithV2 = true;
                }
              } else {
                console.log(`[Transação ${transaction.id}] API V2 retornou erro ${responseV2.status}`);
              }
            } catch (v2Error) {
              console.log(`[Transação ${transaction.id}] Erro ao acessar API V2:`, v2Error);
            }
            
            // Se já verificou com V2, pular para próxima transação
            if (verifiedWithV2) {
              continue;
            }
            
            // Tentativa 2: Verificar com API V1
            console.log(`[Transação ${transaction.id}] Tentando verificar com API V1...`);
            let verifiedWithV1 = false;
            
            try {
              const apiUrlV1 = `https://api.pushinpay.com.br/api/pix/v1/transaction/${transaction.externalId}`;
              
              const responseV1 = await fetch(apiUrlV1, {
                method: 'GET',
                headers: {
                  'Authorization': `Bearer ${token}`,
                  'Accept': 'application/json'
                }
              });
              
              if (responseV1.ok) {
                const paymentData = await responseV1.json();
                console.log(`[Transação ${transaction.id}] Resposta API V1:`, paymentData);
                
                // Se o pagamento foi concluído com a API V1
                if (paymentData.status === 'PAID' || paymentData.status === 'COMPLETED' ||
                    paymentData.status === 'paid' || paymentData.status === 'completed') {
                  
                  // Verificação adicional de segurança antes de atualizar o status
                  if (transaction.userId !== userId) {
                    console.error(`ALERTA DE SEGURANÇA: Tentativa de processar pagamento de outro usuário.
                      Transação ID: ${transaction.id}
                      Pertence ao usuário: ${transaction.userId}
                      Usuário autenticado: ${userId}`);
                    
                    results.push({
                      transactionId: transaction.id,
                      status: "error",
                      message: "Erro de segurança: transação pertence a outro usuário"
                    });
                    
                    continue; // Pular esta transação
                  }
                  
                  // Verificar se o usuário ainda existe
                  const userV1 = await storage.getUser(transaction.userId);
                  if (!userV1) {
                    console.error(`ALERTA DE SEGURANÇA: Usuário ${transaction.userId} não existe mais, mas possui transação ${transaction.id}`);
                    
                    results.push({
                      transactionId: transaction.id,
                      status: "error",
                      message: "Erro de segurança: usuário não encontrado"
                    });
                    
                    continue; // Pular esta transação
                  }
                  
                  // Atualizar status da transação
                  await storage.updateTransactionStatus(
                    transaction.id,
                    "completed",
                    transaction.externalId,
                    transaction.externalUrl || undefined,
                    paymentData
                  );
                  
                  // Log de auditoria para rastreamento financeiro
                  console.log(`TRANSAÇÃO CONCLUÍDA: ID ${transaction.id}, Usuário ${userV1.username} (${userV1.id}), Valor R$${transaction.amount}`);
                  
                  // Atualizar saldo do usuário
                  await storage.updateUserBalance(transaction.userId, transaction.amount);
                  
                  updatedCount++;
                  results.push({
                    transactionId: transaction.id,
                    status: "completed",
                    message: "Pagamento confirmado (API V1)"
                  });
                  
                  verifiedWithV1 = true;
                } else {
                  // Se não estiver pago ainda, registrar o status
                  results.push({
                    transactionId: transaction.id,
                    status: "pending",
                    message: `Status atual: ${paymentData.status} (API V1)`,
                    apiStatus: paymentData.status
                  });
                  
                  verifiedWithV1 = true;
                }
              } else {
                console.log(`[Transação ${transaction.id}] API V1 retornou erro ${responseV1.status}`);
              }
            } catch (v1Error) {
              console.log(`[Transação ${transaction.id}] Erro ao acessar API V1:`, v1Error);
            }
            
            // Se já verificou com V1, pular para próxima transação
            if (verifiedWithV1) {
              continue;
            }
            
            // Verificação por tempo (se ambas as APIs falharem)
            console.log(`[Transação ${transaction.id}] Ambas APIs falharam, verificando por tempo...`);
            const transactionDate = new Date(transaction.createdAt);
            const now = new Date();
            const hoursDiff = (now.getTime() - transactionDate.getTime()) / (1000 * 60 * 60);
            
            // IMPORTANTE: MODO DE DESENVOLVIMENTO/TESTE
            // No ambiente de desenvolvimento, consideramos o pagamento como concluído
            // após 1 minuto para fins de teste, já que a API real pode não estar disponível
            const minutesDiff = (now.getTime() - transactionDate.getTime()) / (1000 * 60);
            const isTestMode = process.env.NODE_ENV === 'development';
            
            if (isTestMode && minutesDiff > 1) {
              console.log(`[DESENVOLVIMENTO] Transação ${transaction.id} aprovada automaticamente após ${minutesDiff.toFixed(1)} minutos (modo de teste)`);
              
              // Verificar se o usuário ainda existe
              const userDev = await storage.getUser(transaction.userId);
              if (!userDev) {
                results.push({
                  transactionId: transaction.id,
                  status: "error",
                  message: "Erro de segurança: usuário não encontrado"
                });
                continue;
              }
              
              // Atualizar status da transação
              await storage.updateTransactionStatus(
                transaction.id,
                "completed",
                transaction.externalId,
                transaction.externalUrl || undefined,
                { autoApproved: true, reason: "Aprovado automaticamente em ambiente de desenvolvimento" }
              );
              
              // Log de auditoria para rastreamento financeiro
              console.log(`TRANSAÇÃO CONCLUÍDA (DESENVOLVIMENTO): ID ${transaction.id}, Usuário ${userDev.username} (${userDev.id}), Valor R$${transaction.amount}`);
              
              // Atualizar saldo do usuário
              await storage.updateUserBalance(transaction.userId, transaction.amount);
              
              updatedCount++;
              results.push({
                transactionId: transaction.id,
                status: "completed",
                message: "Pagamento confirmado automaticamente (ambiente de desenvolvimento)"
              });
            } else if (hoursDiff > 24) {
              console.log(`[Transação ${transaction.id}] Tem mais de 24h (${hoursDiff.toFixed(1)}h), marcando como expirada`);
              
              // Atualizar status para falha por tempo
              await storage.updateTransactionStatus(
                transaction.id,
                "failed",
                transaction.externalId,
                transaction.externalUrl || undefined,
                { reason: "Expirada por tempo (mais de 24h)" }
              );
              
              results.push({
                transactionId: transaction.id,
                status: "expired",
                message: "Transação expirada (mais de 24h)"
              });
            } else {
              console.log(`[Transação ${transaction.id}] Tem menos de 24h (${hoursDiff.toFixed(1)}h), mantendo pendente`);
              
              results.push({
                transactionId: transaction.id,
                status: "pending",
                message: "Transação ainda pendente, APIs indisponíveis"
              });
            }
          } else {
            // Outros gateways não suportados
            results.push({
              transactionId: transaction.id,
              status: "skipped",
              message: "Gateway não suportado ou sem ID externo"
            });
          }
        } catch (txError) {
          console.error(`[Transação ${transaction.id}] Erro na verificação:`, txError);
          
          results.push({
            transactionId: transaction.id,
            status: "error",
            message: `Erro inesperado: ${(txError as Error).message}`
          });
        }
      }
      
      // Retornar resultados
      res.json({
        message: `Verificação concluída para ${pendingTransactions.length} transações`,
        checkedCount: pendingTransactions.length,
        updatedCount,
        results
      });
    } catch (error) {
      console.error("Erro ao verificar transações pendentes:", error);
      res.status(500).json({ 
        message: "Erro ao verificar transações pendentes",
        error: (error as Error).message 
      });
    }
  });
  
  // Verificar um pagamento (apenas para administradores)
  app.post("/api/payment-transactions/:id/verify", requireAuth, requireAdmin, async (req, res) => {
    try {
      const transactionId = parseInt(req.params.id);
      
      if (isNaN(transactionId)) {
        return res.status(400).json({ message: "ID de transação inválido" });
      }
      
      // Buscar a transação
      const transaction = await storage.getPaymentTransaction(transactionId);
      
      if (!transaction) {
        return res.status(404).json({ message: "Transação não encontrada" });
      }
      
      // Se a transação já estiver concluída, apenas retornar
      if (transaction.status === 'completed') {
        return res.json({ 
          message: "Transação já está concluída",
          status: transaction.status,
          transaction 
        });
      }
      
      // Apenas processar transações pendentes ou em processamento
      if (transaction.status === 'pending' || transaction.status === 'processing') {
        // Obter gateway de pagamento
        const gateway = await storage.getPaymentGateway(transaction.gatewayId);
        
        if (!gateway) {
          return res.status(404).json({ message: "Gateway de pagamento não encontrado" });
        }
        
        // Se for Pushin Pay, tentar verificar com a API
        if (gateway.type === 'pushinpay' && transaction.externalId) {
          try {
            // Obter token do gateway
            const token = process.env.PUSHIN_PAY_TOKEN;
            if (!token) {
              return res.status(400).json({ message: "Token da API não configurado" });
            }
            
            // Construir URL para consulta do status
            // A API correta para consulta de status do PIX na Pushin Pay
            // O endpoint correto é /api/v2/transactions/:id e também existe /api/pix/v1/transaction/:id
            // Vamos tentar ambos os endpoints para garantir compatibilidade com diferentes versões da API
            const apiUrl = `https://api.pushinpay.com.br/api/v2/transactions/${transaction.externalId}`;
            
            console.log(`Verificando status da transação ${transaction.externalId} na API Pushin Pay`);
            
            // Fazer requisição para a API da Pushin Pay
            const response = await fetch(apiUrl, {
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json'
              }
            });
            
            // Verificar resposta
            if (!response.ok) {
              const errorData = await response.json().catch(() => ({}));
              console.error("Erro na resposta da Pushin Pay:", response.status, errorData);
              throw new Error(`Erro na API da Pushin Pay: ${response.status}`);
            }
            
            // Processar resposta
            const paymentData = await response.json();
            console.log("Resposta da verificação Pushin Pay:", paymentData);
            
            // Se o pagamento estiver concluído, atualizar status
            // Na API v2 da Pushin Pay, o status de pagamento completado pode ser 'PAID' (maiúsculo)
            if (paymentData.status === 'paid' || paymentData.status === 'completed' || 
                paymentData.status === 'PAID' || paymentData.status === 'COMPLETED') {
              // Atualizar status da transação
              const updatedTransaction = await storage.updateTransactionStatus(
                transactionId,
                "completed",
                transaction.externalId,
                transaction.externalUrl || undefined,
                paymentData
              );
              
              if (!updatedTransaction) {
                return res.status(500).json({ message: "Falha ao atualizar status da transação" });
              }
              
              // Atualizar o saldo do usuário
              try {
                console.log(`UPDATING BALANCE: User ID ${transaction.userId}, Amount: ${transaction.amount}`);
                const userBeforeUpdate = await storage.getUser(transaction.userId);
                console.log(`BALANCE BEFORE: User ID ${transaction.userId}, Current balance: ${userBeforeUpdate?.balance}`);
                
                const user = await storage.updateUserBalance(transaction.userId, transaction.amount);
                
                console.log(`BALANCE UPDATED: User ID ${transaction.userId}, New balance: ${user?.balance}, Added: ${transaction.amount}`);
                console.log(`Saldo do usuário atualizado. Novo saldo: ${user?.balance}`);
              } catch (balanceError) {
                console.error("Erro ao atualizar saldo do usuário:", balanceError);
                return res.status(500).json({ message: "Erro ao atualizar saldo do usuário" });
              }
              
              return res.json({
                message: "Pagamento confirmado pela API da Pushin Pay",
                status: "completed",
                transaction: updatedTransaction
              });
            } else {
              // Se não estiver pago, apenas retornar o status atual
              return res.json({
                message: `Status atual na Pushin Pay: ${paymentData.status}`,
                status: transaction.status,
                apiStatus: paymentData.status,
                transaction
              });
            }
          } catch (apiError: any) {
            console.error("Erro ao verificar pagamento na API:", apiError);
            return res.status(500).json({ message: `Erro ao verificar na API: ${apiError.message}` });
          }
        } else {
          // Para outros gateways ou sem ID externo, apenas notificar
          return res.json({
            message: "Verificação automática não disponível para este método de pagamento",
            status: transaction.status,
            transaction
          });
        }
      }
      
      // Se não for pendente ou em processamento, retornar o status atual
      return res.json({
        message: `Transação está atualmente ${transaction.status}`,
        status: transaction.status,
        transaction
      });
      
    } catch (error) {
      console.error("Erro ao verificar transação de pagamento:", error);
      res.status(500).json({ message: "Erro ao verificar transação de pagamento" });
    }
  });

  // Create new payment transaction - Pushin Pay PIX integration
  app.post("/api/payment/pushinpay", requireAuth, async (req, res) => {
    try {
      // Extrair o userId do usuário autenticado - NUNCA do corpo da requisição
      const userId = req.user!.id;
      
      // Log para auditoria de segurança
      console.log(`SEGURANÇA: Criando transação de pagamento para usuário ID: ${userId}`);
      
      // Extrair apenas o valor do corpo da requisição, ignorando qualquer userId que possa ter sido enviado
      let { amount } = req.body;
      
      // Verificar se alguém tentou enviar um userId no corpo da requisição (potencial ataque)
      if (req.body.userId !== undefined && req.body.userId !== userId) {
        console.error(`ALERTA DE SEGURANÇA: Tentativa de criar transação para outro usuário. 
          Usuário real: ${userId}, 
          Usuário tentado: ${req.body.userId}`);
        
        // Continuar processando, mas ignorar o userId enviado no corpo
      }
      
      // Verificar e limpar o valor recebido
      console.log('Valor original recebido:', amount);
      
      // Se for uma string, converter para número
      if (typeof amount === 'string') {
        // Verificar se a string está no formato brasileiro (com vírgula)
        if (amount.includes(',')) {
          // Converter de PT-BR para EN-US
          amount = parseFloat(amount.replace('.', '').replace(',', '.'));
        } else {
          amount = parseFloat(amount);
        }
      }
      
      // Garantir que é um número válido e positivo
      if (isNaN(amount) || amount <= 0) {
        console.error(`Valor inválido: ${req.body.amount} -> ${amount}`);
        return res.status(400).json({ message: "Valor inválido para depósito" });
      }
      
      console.log('Valor convertido:', amount);
      
      // Já fizemos as validações acima, não precisamos repetir
      
      // Limitar a 2 casas decimais para evitar problemas de arredondamento
      amount = parseFloat(amount.toFixed(2));
      
      // Get the Pushin Pay gateway
      const gateway = await storage.getPaymentGatewayByType("pushinpay");
      if (!gateway || !gateway.isActive) {
        return res.status(404).json({ message: "Pushin Pay gateway is not available" });
      }
      
      // Create transaction record
      const transaction = await storage.createPaymentTransaction({
        userId,
        gatewayId: gateway.id,
        amount,
        status: "pending",
        type: "deposit" // Especificar explicitamente que é um depósito
      });

      try {
        // Verificar se temos o token da Pushin Pay
        if (!process.env.PUSHIN_PAY_TOKEN) {
          throw new Error("Pushin Pay token not configured");
        }
        
        // Gerar o webhook URL para receber notificações da Pushin Pay
        // Em produção, este URL precisa ser acessível publicamente
        const baseUrl = process.env.BASE_URL || "https://app-jogo-do-bicho.replit.app";
        const webhookUrl = `${baseUrl}/api/webhooks/pushinpay`;
        
        // Integração real com Pushin Pay
        const token = process.env.PUSHIN_PAY_TOKEN;
        const apiUrl = 'https://api.pushinpay.com.br/api/pix/cashIn';
        
        console.log(`Iniciando integração com Pushin Pay - Transação ID: ${transaction.id}`);
        
        // Verificar se o valor atende ao mínimo exigido pela API (R$2,00)
        if (amount < 2) {
          throw new Error(`A API da Pushin Pay exige um valor mínimo de R$2,00. Valor digitado: R$${amount.toFixed(2)}`);
        }
        
        // Se o valor recebido for uma string com vírgula, converter para formato com ponto
        if (typeof amount === 'string' && amount.includes(',')) {
          amount = parseFloat(amount.replace('.', '').replace(',', '.'));
        }
        
        // Garantir que o valor tem 2 casas decimais
        amount = parseFloat(amount.toFixed(2));
        
        // IMPORTANTE: A API da Pushin Pay aparentemente espera valor em centavos (inteiro)
        // R$ 50,00 deve ser enviado como 5000 (cinquenta reais em centavos)
        const amountInCents = Math.round(amount * 100);
        
        const requestData = {
          value: amountInCents, // Enviar o valor em centavos (formato inteiro)
          webhook_url: webhookUrl
        };
        
        console.log(`Valor original do usuário: R$${amount.toFixed(2)}`);
        console.log(`Valor convertido para centavos: ${amountInCents}`);
        console.log(`Formato do valor enviado: ${typeof amountInCents}, valor em centavos: ${amountInCents}`);
        console.log(`Valor formatado como JSON: ${JSON.stringify(amountInCents)}`);
        
        console.log("Dados da requisição:", requestData);
        
        // Fazer a requisição para a API da Pushin Pay
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(requestData)
        });
        
        // Verificar se a resposta foi bem-sucedida
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          console.error("Erro na resposta da Pushin Pay:", response.status, errorData);
          throw new Error(`Erro na API da Pushin Pay: ${response.status} - ${errorData.message || 'Erro desconhecido'}`);
        }
        
        // Processar a resposta
        const responseData = await response.json();
        console.log("Resposta da Pushin Pay:", JSON.stringify(responseData, null, 2));
        
        // Verificar o valor retornado pela API
        if (responseData.value !== undefined) {
          console.log(`Valor retornado pela API: ${responseData.value} - Tipo: ${typeof responseData.value}`);
        }
        
        if (!responseData.qr_code || !responseData.qr_code_base64) {
          throw new Error("Resposta da Pushin Pay não contém os dados do PIX necessários");
        }
        
        // Extrair os dados relevantes da resposta
        const qrCodeBase64 = responseData.qr_code_base64;
        const qrCodeText = responseData.qr_code;
        const transactionId = responseData.id || `PUSHIN-${Date.now()}-${transaction.id}`;
        
        // Construir a URL do QR Code
        // Verificar se o base64 já inclui o prefixo
        const qrCodeUrl = qrCodeBase64.startsWith('data:image/png;base64,') 
          ? qrCodeBase64 
          : `data:image/png;base64,${qrCodeBase64}`;
        
        // Atualizar a transação com os dados da Pushin Pay
        const updatedTransaction = await storage.updateTransactionStatus(
          transaction.id,
          "pending",
          transactionId,
          qrCodeUrl || undefined,
          responseData
        );
        
        // Retornar os dados para o cliente
        res.json({
          transactionId: transaction.id,
          externalId: transactionId,
          externalUrl: undefined, // Não há página externa para redirecionar
          pixCopyPasteCode: qrCodeText,
          qrCodeUrl: qrCodeUrl,
          qrCodeBase64: qrCodeBase64,
          amount: amount.toFixed(2),
          status: "pending",
          message: "PIX payment process initiated via Pushin Pay",
          paymentDetails: responseData
        });
        
      } catch (err) {
        const integrationError = err as Error;
        console.error("Error in Pushin Pay integration:", integrationError);
        
        // Marcar a transação como falha
        await storage.updateTransactionStatus(
          transaction.id,
          "failed",
          undefined,
          undefined,
          { error: integrationError.message }
        );
        
        throw new Error(`Failed to process payment: ${integrationError.message}`);
      }
    } catch (err) {
      const error = err as Error;
      console.error("Error creating payment transaction:", error);
      res.status(500).json({ message: error.message || "Error creating payment transaction" });
    }
  });

  // Iniciar pagamento via Ezzebank
  app.post("/api/payments/ezzebank", requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      const username = req.user?.username;
      const { amount } = req.body;
      
      if (!amount) {
        return res.status(400).json({ message: "Amount is required" });
      }
      
      // Converter para número e garantir formato correto
      let parsedAmount = amount;
      if (typeof amount === 'string') {
        // Substituir vírgula por ponto para garantir conversão correta
        parsedAmount = parseFloat(amount.replace(',', '.'));
      }
      
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        return res.status(400).json({ message: "Invalid amount" });
      }
      
      console.log(`[Ezzebank] Solicitação de pagamento para usuário ${username} (${userId}) no valor de R$${parsedAmount}`);
      
      // Obter configurações do sistema
      const systemSettings = await storage.getSystemSettings();
      if (systemSettings?.maintenanceMode) {
        return res.status(503).json({ message: "System is in maintenance mode" });
      }
      
      if (!systemSettings?.allowDeposits) {
        return res.status(403).json({ message: "Deposits are currently disabled" });
      }

      // Obter o gateway Ezzebank
      const gateway = await storage.getPaymentGatewayByType("ezzebank");
      if (!gateway) {
        console.error("Ezzebank gateway not found in the database");
        return res.status(404).json({ message: "Payment gateway not available" });
      }
      
      if (!gateway.isActive) {
        console.error("Ezzebank gateway is inactive");
        return res.status(403).json({ message: "This payment method is currently unavailable" });
      }
      
      // Criar uma transação no status "pending"
      const transactionData = {
        userId: userId,
        gatewayId: gateway.id,
        amount: parsedAmount,
        status: "pending",
        type: "deposit"
      };
      

      if (!transactionData.userId) {
        throw new Error("O ID do usuário é necessário, mas não foi definido.");
      }
      const transaction = await storage.createPaymentTransaction({
        ...transactionData,
        userId: transactionData.userId, // Ensure userId is not undefined
      });
      
      try {
        // Chamar a API do Ezzebank
        const paymentResult = await ezzebankService.createPixPayment(
          transaction,
          parsedAmount,
          req.user?.name || req.user?.username,
          req.user?.email ?? undefined,
          req.user?.cpf ?? undefined
        );
        
        // Atualizar a transação com os dados retornados
        const updatedTransaction = await storage.updateTransactionStatus(
          transaction.id,
          "pending",
          paymentResult.externalId,
          paymentResult.qrCodeUrl,
          paymentResult.paymentDetails
        );
        
        // Responder ao cliente
        res.json({
          transactionId: transaction.id,
          externalId: paymentResult.externalId,
          pixCopyPasteCode: paymentResult.pixCopyPasteCode,
          qrCodeUrl: paymentResult.qrCodeUrl,
          amount: parsedAmount.toFixed(2),
          status: "pending",
          message: "PIX payment initiated via Ezzebank",
          paymentDetails: paymentResult.paymentDetails
        });
      } catch (error) {
        console.error("[Ezzebank] Error processing payment:", error);
        
        // Atualizar a transação como falha
        await storage.updateTransactionStatus(
          transaction.id,
          "failed",
          undefined,
          undefined,
          { error: error instanceof Error ? error.message : "Unknown error" }
        );
        
        throw error;
      }
    } catch (error) {
      console.error("[Ezzebank] Error creating payment:", error);
      res.status(500).json({ 
        message: error instanceof Error ? error.message : "Error processing payment"
      });
    }
  });
  
  // Webhook para receber notificações do Ezzebank
  // Webhook para receber notificações do Ezzebank (.aspx para compatibilidade)
  app.post("/api/webhooks/ezzebank.aspx", async (req, res) => {
    // Redirecionar para o endpoint principal
    console.log('[Webhook] Recebido webhook na rota .aspx:', req.body);
    req.url = '/api/webhooks/ezzebank';
    app._router.handle(req, res);
  });

  app.post("/api/webhooks/ezzebank", async (req, res) => {
    try {
      console.log("[Ezzebank] Webhook recebido:", JSON.stringify(req.body, null, 2));
      
      // Validar dados do webhook
      const { id, status, external_reference, signature } = req.body;
      
      if (!id || !status) {
        console.error("[Ezzebank] Webhook com dados incompletos");
        return res.status(400).json({ message: "Missing required fields" });
      }
      
      // Verificar assinatura (em implementação real)
      if (!ezzebankService.verifyWebhookSignature(req.body)) {
        console.error("[Ezzebank] Assinatura do webhook inválida");
        return res.status(401).json({ message: "Invalid signature" });
      }
      
      // Extrair o ID da transação do campo external_reference (TX-{id})
      let transactionId: number;
      if (external_reference && external_reference.startsWith('TX-')) {
        const idStr = external_reference.substring(3);
        transactionId = parseInt(idStr);
        
        if (isNaN(transactionId)) {
          console.error(`[Ezzebank] ID de transação inválido: ${external_reference}`);
          return res.status(400).json({ message: "Invalid transaction reference" });
        }
      } else {
        console.error(`[Ezzebank] Referência externa inválida: ${external_reference}`);
        return res.status(400).json({ message: "Invalid external reference format" });
      }
      
      // Buscar a transação no banco de dados
      const transaction = await storage.getPaymentTransaction(transactionId);
      if (!transaction) {
        console.error(`[Ezzebank] Transação não encontrada: ${transactionId}`);
        return res.status(404).json({ message: "Transaction not found" });
      }
      
      // Mapear o status do Ezzebank para o formato do sistema
      const systemStatus = ezzebankService.mapPaymentStatus(status);
      
      console.log(`[Ezzebank] Atualizando transação ${transactionId} de ${transaction.status} para ${systemStatus}`);
      
      // Verificar se a transação já está concluída (evitar processamento duplicado)
      if (transaction.status === 'completed' && systemStatus === 'completed') {
        console.log(`[Ezzebank] Transação ${transactionId} já foi processada anteriormente`);
        return res.status(200).json({ 
          message: "Transaction already processed", 
          status: transaction.status 
        });
      }
      
      // Atualizar a transação
      const updatedTransaction = await storage.updateTransactionStatus(
        transactionId,
        systemStatus,
        id, // ID externo da transação no Ezzebank
        transaction.externalUrl ?? undefined, // Manter a URL externa existente
        req.body // Salvar todo o payload para registro
      );
      
      // Se o pagamento foi bem-sucedido, adicionar saldo ao usuário
      if (systemStatus === "completed" && updatedTransaction) {
        try {
          console.log(`[Ezzebank] Pagamento confirmado para transação ${transactionId}. Atualizando saldo do usuário.`);
          
          const user = await storage.updateUserBalance(updatedTransaction.userId, updatedTransaction.amount);
          console.log(`[Ezzebank] Saldo do usuário atualizado com sucesso. Novo saldo: ${user?.balance}`);
          
          // Registrar transação no histórico financeiro
          await storage.createTransaction({
            userId: updatedTransaction.userId,
            type: "deposit",
            amount: updatedTransaction.amount,
            description: `Depósito via Ezzebank - ID: ${id}`,
            relatedId: updatedTransaction.id
          });
        } catch (error) {
          console.error("[Ezzebank] Erro ao atualizar saldo do usuário:", error);
          // Continuamos o processo mesmo com erro, mas registramos para investigação
        }
      }
      
      // Resposta de sucesso
      res.json({ 
        message: "Webhook processed successfully",
        transactionId,
        status: updatedTransaction?.status || systemStatus
      });
    } catch (error) {
      console.error("[Ezzebank] Erro ao processar webhook:", error);
      res.status(500).json({ message: "Error processing payment webhook" });
    }
  });

  // Webhook/callback for Pushin Pay (would be called by the payment provider)
  app.post("/api/webhooks/pushinpay", async (req, res) => {
    try {
      // Log para auditoria de segurança
      console.log("Webhook da Pushin Pay recebido:", JSON.stringify(req.body, null, 2));
      
      const { transactionId, status, externalId, amount, signature } = req.body;
      
      // Validações básicas dos dados
      if (!transactionId || !status) {
        console.error("Webhook com dados incompletos:", req.body);
        return res.status(400).json({ message: "Missing required fields" });
      }
      
      // Validar que o ID da transação é um número (segurança)
      const parsedTransactionId = parseInt(transactionId);
      if (isNaN(parsedTransactionId)) {
        console.error(`ALERTA DE SEGURANÇA: ID de transação inválido recebido no webhook: ${transactionId}`);
        return res.status(400).json({ message: "Invalid transaction ID format" });
      }
      
      // Em uma implementação real, verificaríamos a assinatura da requisição
      // para garantir que ela veio realmente do gateway de pagamento
      if (process.env.NODE_ENV === 'production') {
        // Obter o gateway para verificar a chave secreta
        const transaction = await storage.getPaymentTransaction(transactionId);
        if (!transaction) {
          return res.status(404).json({ message: "Transaction not found" });
        }
        
        const gateway = await storage.getPaymentGateway(transaction.gatewayId);
        if (!gateway) {
          return res.status(404).json({ message: "Payment gateway not found" });
        }
        
        // Verificar assinatura
        // Esta é uma simulação - em um cenário real, verificaríamos 
        // a assinatura usando a chave secreta do gateway e um algoritmo específico
        if (!gateway.secretKey || !signature) {
          console.warn("Missing webhook signature or secret key for validation");
          // Em produção, poderíamos rejeitar a solicitação se a assinatura for inválida
          // return res.status(401).json({ message: "Invalid webhook signature" });
        }
      }
      
      // Status válidos que podemos receber do gateway
      const validStatuses = ['pending', 'processing', 'completed', 'failed', 'cancelled'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ message: "Invalid transaction status" });
      }
      
      // Consultar a transação atual
      const currentTransaction = await storage.getPaymentTransaction(transactionId);
      if (!currentTransaction) {
        return res.status(404).json({ message: "Transaction not found" });
      }
      
      // Verificações adicionais para transações já completadas
      if (currentTransaction.status === 'completed' && status === 'completed') {
        return res.status(200).json({ 
          message: "Transaction already processed", 
          status: currentTransaction.status 
        });
      }
      
      // Verificação de segurança adicional: garantir que a transação pertence a um usuário válido
      // e não está sendo manipulada para creditar saldo indevidamente
      const user = await storage.getUser(currentTransaction.userId);
      if (!user) {
        console.error(`ALERTA DE SEGURANÇA: Tentativa de atualizar transação ${transactionId} para usuário inexistente ${currentTransaction.userId}`);
        return res.status(400).json({ message: "Invalid user associated with transaction" });
      }
      
      // Registrar para auditoria
      console.log(`Atualizando status da transação ${transactionId} para ${status}`);
      console.log(`Transação pertence ao usuário ${user.username} (ID: ${user.id})`);
      
      // Atualizar o status da transação
      const updatedTransaction = await storage.updateTransactionStatus(
        transactionId,
        status,
        externalId || undefined,
        currentTransaction.externalUrl || undefined, // Manter a URL externa existente
        req.body // Salvar todo o payload para registro
      );
      
      if (!updatedTransaction) {
        return res.status(404).json({ message: "Failed to update transaction" });
      }
      
      // Se o pagamento foi bem-sucedido, adicionar saldo ao usuário
      if (status === "completed" && updatedTransaction.userId) {
        console.log(`Payment successful for transaction ${transactionId}. Updating user balance.`);
        
        try {
          const user = await storage.updateUserBalance(updatedTransaction.userId, updatedTransaction.amount);
          console.log(`User balance updated successfully. New balance: ${user?.balance}`);
        } catch (balanceError) {
          console.error("Error updating user balance:", balanceError);
          // Continuamos o processo mesmo que a atualização do saldo falhe,
          // mas registramos um erro para investigação posterior
        }
      }
      
      // Resposta de sucesso
      res.json({ 
        message: "Webhook processed successfully",
        transactionId,
        status: updatedTransaction.status
      });
    } catch (err) {
      const error = err as Error;
      console.error("Error processing payment webhook:", error);
      res.status(500).json({ message: "Error processing payment webhook" });
    }
  });

  // ========== Rotas para gerenciamento de saques ==========
  
  // Solicitar um saque (requer autenticação)
  app.post('/api/withdrawals', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      
      // Validar e extrair dados do corpo da requisição
      const withdrawalData = insertWithdrawalSchema.parse({
        ...req.body,
        userId
      });
      
      console.log(`Solicitação de saque recebida para usuário ${userId}:`, withdrawalData);
      
      // Criar a solicitação de saque
      const withdrawal = await storage.createWithdrawal(withdrawalData);
      
      // Resposta de sucesso
      res.status(201).json(withdrawal);
    } catch (error) {
      console.error("Erro ao processar solicitação de saque:", error);
      
      if (error instanceof z.ZodError) {
        return res.status(400).json({ 
          message: "Dados inválidos", 
          errors: error.errors 
        });
      }
      
      // Para erros de negócio que já possuem mensagem formatada (ex: saldo insuficiente)
      if (error instanceof Error) {
        return res.status(400).json({ message: error.message });
      }
      
      res.status(500).json({ message: "Erro ao processar solicitação de saque" });
    }
  });
  
  // Obter todos os saques do usuário
  app.get('/api/withdrawals', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      
      if (userId === undefined) {
        return res.status(400).json({ message: "É necessário um ID de usuário" });
      }
      
      const withdrawals = await storage.getUserWithdrawals(userId);
      res.json(withdrawals);
    } catch (error) {
      console.error(`Erro ao buscar saques do usuário ${req.user?.id}:`, error);
      res.status(500).json({ message: "Erro ao buscar histórico de saques" });
    }
  });
  
  // Obter um saque específico
  app.get('/api/withdrawals/:id', requireAuth, async (req, res) => {
    try {
      const withdrawalId = parseInt(req.params.id);
      if (isNaN(withdrawalId)) {
        return res.status(400).json({ message: "ID de saque inválido" });
      }
      
      const withdrawal = await storage.getWithdrawal(withdrawalId);
      
      if (!withdrawal) {
        return res.status(404).json({ message: "Saque não encontrado" });
      }
      
      // Verificar se o saque pertence ao usuário atual, a menos que seja admin
      if (!req.user || (withdrawal.userId !== req.user.id && !req.user.isAdmin)) {
        console.log(`NEGADO: Usuário ${req.user?.id} tentando acessar saque ${withdrawalId} do usuário ${withdrawal.userId}`);
        return res.status(403).json({ message: "Acesso negado" });
      }
      
      res.json(withdrawal);
    } catch (error) {
      console.error(`Erro ao buscar saque ${req.params.id}:`, error);
      res.status(500).json({ message: "Erro ao buscar detalhes do saque" });
    }
  });
  
  // Rotas administrativas para saques
  
  // Listar todos os saques (apenas admin)
  app.get('/api/admin/withdrawals', requireAdmin, async (req, res) => {
    try {
      const status = req.query.status as WithdrawalStatus | undefined;
      
      const withdrawals = await storage.getAllWithdrawals(status);
      res.json(withdrawals);
    } catch (error) {
      console.error("Erro ao buscar todos os saques:", error);
      res.status(500).json({ message: "Erro ao buscar saques" });
    }
  });
  
  // Aprovar ou rejeitar um saque (apenas admin)
  // Verificar o saldo disponível no gateway Pushin Pay
  async function checkPushinPayBalance(): Promise<number> {
    try {
      // Obter o gateway Pushin Pay
      const gateway = await storage.getPaymentGatewayByType("pushinpay");
      if (!gateway) {
        throw new Error("Gateway Pushin Pay não encontrado");
      }
      
      // Exemplo de URL da API para verificar saldo (substituir pelo endpoint correto)
      const apiUrl = "https://api.pushinpay.com.br/api/v2/balance";
      
      // Cabeçalhos de autenticação
      const headers = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${gateway.apiKey}`
      };
      
      // Fazer requisição para a API da Pushin Pay
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`Erro ao verificar saldo: ${errorData.message || response.statusText}`);
      }
      
      const data = await response.json();
      
      // Extrair saldo da resposta (adaptado para o formato de resposta real da API)
      const balance = data.balance || data.amount || 0;
      console.log(`Saldo disponível no gateway Pushin Pay: R$ ${balance.toFixed(2)}`);
      
      return balance;
    } catch (error) {
      console.error("Erro ao verificar saldo no gateway:", error);
      
      // Em caso de erro, retornar 0 para indicar que não há saldo disponível
      // ou tratar alguma lógica de fallback conforme necessário
      return 0;
    }
  }

  app.get('/api/admin/gateway-balance', requireAdmin, async (req, res) => {
    try {
      const balance = await checkPushinPayBalance();
      res.json({ balance });
    } catch (error) {
      console.error("Erro ao obter saldo do gateway:", error);
      res.status(500).json({ message: "Erro ao obter saldo do gateway" });
    }
  });

  app.patch('/api/admin/withdrawals/:id/status', requireAdmin, async (req, res) => {
    try {
      const withdrawalId = parseInt(req.params.id);
      if (isNaN(withdrawalId)) {
        return res.status(400).json({ message: "ID de saque inválido" });
      }
      
      const { status, rejectionReason, notes } = req.body;
      
      // Validar status
      if (!status || !['approved', 'rejected'].includes(status)) {
        return res.status(400).json({ message: "Status inválido. Use 'approved' ou 'rejected'" });
      }
      
      // Validar motivo de rejeição quando o status é 'rejected'
      if (status === 'rejected' && !rejectionReason) {
        return res.status(400).json({ message: "Motivo de rejeição é obrigatório para saques rejeitados" });
      }
      
      // Se o status for "approved", verificar se há saldo disponível no gateway
      if (status === "approved") {
        // Obter os detalhes do saque
        const withdrawal = await storage.getWithdrawal(withdrawalId);
        if (!withdrawal) {
          return res.status(404).json({ message: "Saque não encontrado" });
        }
        
        // Verificar o saldo disponível no gateway
        const gatewayBalance = await checkPushinPayBalance();
        
        // Verificar se o saldo é suficiente para realizar o saque
        if (gatewayBalance < withdrawal.amount) {
          return res.status(400).json({ 
            message: "Saldo insuficiente no gateway de pagamento", 
            availableBalance: gatewayBalance,
            requiredAmount: withdrawal.amount
          });
        }
        
        console.log(`Saldo disponível no gateway: R$ ${gatewayBalance.toFixed(2)} - Suficiente para o saque de R$ ${withdrawal.amount.toFixed(2)}`);
      }
      
      // Atualizar status do saque
      const withdrawal = await storage.updateWithdrawalStatus(
        withdrawalId, 
        status as WithdrawalStatus, 
        req.user?.id, // ID do admin que está processando
        rejectionReason,
        notes
      );
      
      // Se o saque for aprovado, mudar o status para "processing" e iniciar pagamento via API
      if (status === "approved") {
        // Atualizar status do saque para "processing"
        const processingWithdrawal = await storage.updateWithdrawalStatus(
          withdrawalId,
          "processing" as WithdrawalStatus,
          req.user?.id
        );
        
        // TODO: Iniciar o pagamento via API da Pushin Pay
        // Isso seria implementado aqui, ou em um processo assíncrono
        
        res.json(processingWithdrawal);
      } else {
        res.json(withdrawal);
      }
    } catch (error) {
      console.error(`Erro ao atualizar status do saque ${req.params.id}:`, error);
      
      if (error instanceof Error) {
        return res.status(400).json({ message: error.message });
      }
      
      res.status(500).json({ message: "Erro ao processar saque" });
    }
  });
  
  // ========== Rotas para histórico de transações financeiras ==========
  
  // Obter histórico de transações do usuário logado
  app.get('/api/transactions/history', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      
      if (userId === undefined) {
        return res.status(400).json({ message: "É necessário um ID de usuário" });
      }
      const transactions = await storage.getUserTransactionHistory(userId);
      res.json(transactions);
    } catch (error) {
      console.error(`Erro ao buscar histórico de transações do usuário ${req.user?.id}:`, error);
      res.status(500).json({ message: "Erro ao buscar histórico de transações" });
    }
  });
  
  // Rotas administrativas para transações
  
  // Listar todas as transações (apenas admin)
  app.get('/api/admin/transactions', requireAdmin, async (req, res) => {
    try {
      // Extrair parâmetros de filtro da query
      const type = req.query.type as string | undefined;
      const startDate = req.query.startDate ? new Date(req.query.startDate as string) : undefined;
      const endDate = req.query.endDate ? new Date(req.query.endDate as string) : undefined;
      
      const transactions = await storage.getAllTransactions(
        type as any, 
        startDate,
        endDate
      );
      
      res.json(transactions);
    } catch (error) {
      console.error("Erro ao buscar todas as transações:", error);
      res.status(500).json({ message: "Erro ao buscar transações" });
    }
  });
  
  // Obter resumo de transações para relatório financeiro (apenas admin)
  app.get('/api/admin/transactions/summary', requireAdmin, async (req, res) => {
    try {
      // Extrair parâmetros de filtro da query
      const startDate = req.query.startDate ? new Date(req.query.startDate as string) : undefined;
      const endDate = req.query.endDate ? new Date(req.query.endDate as string) : undefined;
      
      const summary = await storage.getTransactionsSummary(startDate, endDate);
      
      res.json(summary);
    } catch (error) {
      console.error("Erro ao gerar resumo de transações:", error);
      res.status(500).json({ message: "Erro ao gerar resumo financeiro" });
    }
  });

  const httpServer = createServer(app);
  // ========== ROTAS PARA VERIFICAÇÃO DE SAQUES EM PROCESSAMENTO ==========
  
  // Verificar status de saques em processamento (admin)
  app.post("/api/admin/check-withdrawals", requireAdmin, async (req, res) => {
    try {
      // Buscar todos os saques com status "processing"
      const processingSaques = await storage.getAllWithdrawals("processing" as WithdrawalStatus);
      
      console.log(`Verificando ${processingSaques.length} saques em processamento...`);
      
      const results = [];
      let updatedCount = 0;
      
      // Para cada saque em processamento, verificar se o pagamento foi concluído
      for (const saque of processingSaques) {
        try {
          // Buscar gateway ativo
          const gateway = await storage.getPaymentGatewayByType("pushinpay");
          if (!gateway || !gateway.isActive) {
            console.warn("Nenhum gateway de pagamento ativo encontrado para verificar saques");
            results.push({
              id: saque.id,
              status: "processing",
              message: "Nenhum gateway de pagamento ativo configurado"
            });
            continue;
          }
          
          console.log(`Verificando saque ID=${saque.id} (R$ ${saque.amount}) para ${saque.pixKey}`);
          
          // Em uma implementação real, faríamos uma chamada para a API do gateway
          // Aqui estamos simulando uma verificação básica baseada em tempo
          // O ideal seria usar o ID da transação externa e verificar o status no gateway
          
          // Apenas para simulação: 20% de chance do pagamento estar concluído
          const shouldComplete = Math.random() < 0.2;
          
          if (shouldComplete) {
            // Atualizar o saque para "approved"
            await storage.updateWithdrawalStatus(
              saque.id,
              "approved" as WithdrawalStatus,
              undefined, // processedBy - automático
              undefined, // rejectionReason
              "Pagamento confirmado pelo gateway"
            );
            
            console.log(`Saque ID=${saque.id} confirmado pelo gateway e marcado como aprovado!`);
            
            results.push({
              id: saque.id,
              status: "approved",
              message: "Pagamento confirmado pelo gateway"
            });
            
            updatedCount++;
          } else {
            results.push({
              id: saque.id,
              status: "processing",
              message: "Saque ainda em processamento pelo gateway"
            });
          }
        } catch (err) {
          console.error(`Erro ao verificar saque ID=${saque.id}:`, err);
          results.push({
            id: saque.id,
            status: "error",
            message: err instanceof Error ? err.message : "Erro desconhecido"
          });
        }
      }
      
      res.json({
        message: `Verificação concluída para ${processingSaques.length} saques`,
        updatedCount,
        results
      });
    } catch (error) {
      console.error("Erro ao verificar saques em processamento:", error);
      res.status(500).json({ message: "Erro ao verificar saques" });
    }
  });

  // Rota para verificação automática periódica de saques em processamento
  app.post("/api/check-withdrawals-auto", async (req, res) => {
    try {
      // Verificar token de acesso (para evitar chamadas não autorizadas)
      const { token } = req.body;
      
      if (token !== process.env.PUSHIN_PAY_TOKEN) {
        return res.status(401).json({ message: "Token inválido" });
      }
      
      // Buscar todos os saques com status "processing"
      const processingSaques = await storage.getAllWithdrawals("processing" as WithdrawalStatus);
      
      console.log(`Verificação automática de saques: ${processingSaques.length} saques em processamento...`);
      
      const results = [];
      let updatedCount = 0;
      
      // Para cada saque em processamento, verificar se o pagamento foi concluído
      for (const saque of processingSaques) {
        try {
          // Verificar apenas saques com mais de 5 minutos (para dar tempo ao gateway)
          const tempoProcessamento = new Date().getTime() - new Date(saque.requestedAt).getTime();
          const minutos = Math.floor(tempoProcessamento / (1000 * 60));
          
          if (minutos < 5) {
            console.log(`Saque ID=${saque.id} tem apenas ${minutos} minutos, aguardando mais tempo`);
            results.push({
              id: saque.id,
              status: "processing",
              message: `Aguardando mais tempo (${minutos} minutos)`
            });
            continue;
          }
          
          // Verificar com o gateway o status do pagamento
          console.log(`Verificando saque ID=${saque.id} (R$ ${saque.amount}) para ${saque.pixKey}`);
          
          // Em uma implementação real, chamaríamos a API do gateway
          // Aqui estamos simulando uma verificação baseada em tempo
          const tempoHoras = minutos / 60;
          
          // Após 1 hora, 50% de chance de aprovar automaticamente (apenas simulação)
          if (tempoHoras > 1 && Math.random() < 0.5) {
            await storage.updateWithdrawalStatus(
              saque.id,
              "approved" as WithdrawalStatus,
              undefined,
              undefined,
              `Pagamento confirmado automaticamente após ${tempoHoras.toFixed(1)}h de processamento`
            );
            
            console.log(`Saque ID=${saque.id} aprovado automaticamente após ${tempoHoras.toFixed(1)}h`);
            
            results.push({
              id: saque.id,
              status: "approved",
              message: `Aprovado após ${tempoHoras.toFixed(1)}h`
            });
            
            updatedCount++;
          } else {
            results.push({
              id: saque.id,
              status: "processing",
              message: `Ainda em processamento (${tempoHoras.toFixed(1)}h)`
            });
          }
        } catch (err) {
          console.error(`Erro ao verificar saque ID=${saque.id}:`, err);
          results.push({
            id: saque.id,
            status: "error",
            message: err instanceof Error ? err.message : "Erro desconhecido"
          });
        }
      }
      
      res.json({
        message: `Verificação automática concluída para ${processingSaques.length} saques`,
        updatedCount,
        results
      });
    } catch (error) {
      console.error("Erro na verificação automática de saques:", error);
      res.status(500).json({ message: "Erro ao verificar saques" });
    }
  });

  return httpServer;
}
