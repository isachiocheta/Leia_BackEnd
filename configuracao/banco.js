'use strict';

function lerBanco(valor, variavel) {
  const mensagem = `${variavel} deve ser uma URL PostgreSQL válida com um banco explícito.`;

  if (
    typeof valor !== 'string' ||
    /\s/.test(valor) ||
    !/^postgres(?:ql)?:\/\/[^/?#]+\/[^/?#]+(?:\?[^#]*)?$/i.test(valor)
  ) {
    throw new Error(mensagem);
  }

  let endereco;
  let nomeBanco;

  try {
    endereco = new URL(valor);
    nomeBanco = decodeURIComponent(endereco.pathname.slice(1));

    for (const credencial of [endereco.username, endereco.password]) {
      if (/[\u0000-\u001f\u007f]/.test(decodeURIComponent(credencial))) {
        throw new Error(mensagem);
      }
    }
  } catch {
    throw new Error(mensagem);
  }

  if (
    !['postgres:', 'postgresql:'].includes(endereco.protocol) ||
    !endereco.hostname ||
    endereco.hash ||
    !/^[a-z0-9_][a-z0-9_-]{0,62}$/i.test(nomeBanco)
  ) {
    throw new Error(mensagem);
  }

  // O driver pode usar parâmetros da URL para substituir banco, host ou usuário.
  // Permitir apenas sslmode impede que a validação examine um destino diferente.
  const parametros = [...endereco.searchParams];
  const modosSsl = ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'];

  if (
    parametros.length > 1 ||
    parametros.some(([nome, conteudo]) => nome !== 'sslmode' || !modosSsl.includes(conteudo))
  ) {
    throw new Error(`${variavel} aceita somente o parâmetro sslmode de conexão.`);
  }

  return { url: valor, nomeBanco };
}

function criarConfiguracao(banco, ambiente) {
  return {
    ...banco,
    ambiente,
    opcoes: {
      dialect: 'postgres',
      logging: false,
      pool: { max: 5, min: 0, idle: 10000, acquire: 5000 },
      dialectOptions: {
        connectionTimeoutMillis: 3000,
        query_timeout: 3000,
        statement_timeout: 3000,
      },
    },
  };
}

function validarBancoTeste(variaveis = process.env) {
  if (variaveis.NODE_ENV !== 'test') {
    throw new Error('Operações no banco de teste exigem NODE_ENV=test.');
  }

  const bancoNormal = lerBanco(variaveis.DATABASE_URL, 'DATABASE_URL');
  const bancoTeste = lerBanco(variaveis.TEST_DATABASE_URL, 'TEST_DATABASE_URL');

  if (!/(?:_test|_teste)$/i.test(bancoTeste.nomeBanco)) {
    throw new Error('TEST_DATABASE_URL deve identificar um banco com sufixo _test ou _teste.');
  }

  // Comparar apenas o nome é conservador: hosts e credenciais distintos também
  // podem apontar ao mesmo PostgreSQL por aliases ou encaminhamento de portas.
  if (bancoTeste.nomeBanco.toLowerCase() === bancoNormal.nomeBanco.toLowerCase()) {
    throw new Error('TEST_DATABASE_URL deve identificar um banco diferente de DATABASE_URL.');
  }

  return criarConfiguracao(bancoTeste, 'test');
}

function carregarConfiguracaoBanco(variaveis = process.env) {
  const ambiente = variaveis.NODE_ENV === undefined ? 'development' : variaveis.NODE_ENV;

  if (!['development', 'test', 'production'].includes(ambiente)) {
    throw new Error('NODE_ENV deve ser development, test ou production.');
  }

  if (ambiente === 'test') {
    return validarBancoTeste(variaveis);
  }

  return criarConfiguracao(lerBanco(variaveis.DATABASE_URL, 'DATABASE_URL'), ambiente);
}

module.exports = { carregarConfiguracaoBanco, validarBancoTeste };
