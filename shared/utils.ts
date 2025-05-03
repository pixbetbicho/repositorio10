/**
 * Função para validar CPF usando o algoritmo oficial
 * 
 * Um CPF válido deve:
 * 1. Ter 11 dígitos
 * 2. Não ser uma sequência de dígitos repetidos (ex: 111.111.111-11)
 * 3. Os dois últimos dígitos são verificadores e devem corresponder ao cálculo especificado
 * 
 * @param cpf - String contendo o CPF a ser validado (com ou sem formatação)
 * @returns boolean - true se o CPF for válido, false caso contrário
 */
export function validaCPF(cpf: string): boolean {
  // Remove caracteres não numéricos
  const cpfLimpo = cpf.replace(/[^\d]/g, '');
  
  // Verifica se o CPF tem 11 dígitos
  if (cpfLimpo.length !== 11) {
    return false;
  }
  
  // Verifica se todos os dígitos são iguais (CPF inválido, mas com formato correto)
  if (/^(\d)\1{10}$/.test(cpfLimpo)) {
    return false;
  }
  
  // Calcula o primeiro dígito verificador
  let soma = 0;
  for (let i = 0; i < 9; i++) {
    soma += parseInt(cpfLimpo.charAt(i)) * (10 - i);
  }
  
  let resto = soma % 11;
  const dv1 = resto < 2 ? 0 : 11 - resto;
  
  // Verifica o primeiro dígito verificador
  if (parseInt(cpfLimpo.charAt(9)) !== dv1) {
    return false;
  }
  
  // Calcula o segundo dígito verificador
  soma = 0;
  for (let i = 0; i < 10; i++) {
    soma += parseInt(cpfLimpo.charAt(i)) * (11 - i);
  }
  
  resto = soma % 11;
  const dv2 = resto < 2 ? 0 : 11 - resto;
  
  // Verifica o segundo dígito verificador
  if (parseInt(cpfLimpo.charAt(10)) !== dv2) {
    return false;
  }
  
  return true;
}

/**
 * Função para formatar um CPF adicionando pontos e traço
 * 
 * @param cpf - String contendo o CPF sem formatação (apenas números)
 * @returns string - CPF formatado (ex: 123.456.789-00)
 */
export function formataCPF(cpf: string): string {
  const cpfLimpo = cpf.replace(/[^\d]/g, '');
  
  if (cpfLimpo.length !== 11) {
    return cpf; // Retorna o CPF original se não tiver 11 dígitos
  }
  
  return cpfLimpo.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
}