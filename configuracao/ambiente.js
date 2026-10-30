'use strict';

function carregarAmbiente(variaveis = process.env) {
  const ambiente = variaveis.NODE_ENV ?? 'development';
  const portaInformada = variaveis.PORT ?? '3000';
  const origemPermitida = variaveis.ALLOWED_ORIGIN ?? 'http://localhost:5173';

  if (!['development', 'test', 'production'].includes(ambiente)) {
    throw new Error('NODE_ENV deve ser development, test ou production.');
  }

  const porta = Number(portaInformada);

  if (
    typeof portaInformada !== 'string' ||
    !/^\d+$/.test(portaInformada) ||
    !Number.isInteger(porta) ||
    porta < 1 ||
    porta > 65535
  ) {
    throw new Error('PORT deve ser um número inteiro entre 1 e 65535.');
  }

  let origem;

  try {
    origem = new URL(origemPermitida);
  } catch {
    throw new Error('ALLOWED_ORIGIN deve ser uma única origem HTTP ou HTTPS.');
  }

  if (
    !['http:', 'https:'].includes(origem.protocol) ||
    origem.username ||
    origem.password ||
    origem.hostname.includes('*') ||
    origem.origin !== origemPermitida
  ) {
    throw new Error('ALLOWED_ORIGIN deve ser uma única origem HTTP ou HTTPS, sem caminho ou credenciais.');
  }

  return Object.freeze({ porta, ambiente, origemPermitida });
}

module.exports = { carregarAmbiente };
