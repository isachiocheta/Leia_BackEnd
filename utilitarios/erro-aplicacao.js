'use strict';

const CATALOGO_ERROS = Object.freeze({
  BAD_REQUEST: Object.freeze({ status: 400, message: 'Requisição inválida.' }),
  INVALID_JSON: Object.freeze({ status: 400, message: 'JSON inválido.' }),
  UNAUTHORIZED: Object.freeze({ status: 401, message: 'Autenticação necessária.' }),
  FORBIDDEN: Object.freeze({ status: 403, message: 'Acesso não permitido.' }),
  NOT_FOUND: Object.freeze({ status: 404, message: 'Recurso não encontrado.' }),
  CONFLICT: Object.freeze({ status: 409, message: 'Conflito com o estado atual do recurso.' }),
  PAYLOAD_TOO_LARGE: Object.freeze({ status: 413, message: 'Corpo da requisição excede o limite de 100 KB.' }),
  VALIDATION_ERROR: Object.freeze({ status: 422, message: 'Dados inválidos.' }),
  TOO_MANY_REQUESTS: Object.freeze({ status: 429, message: 'Muitas requisições. Tente novamente mais tarde.' }),
  INTERNAL_ERROR: Object.freeze({ status: 500, message: 'Erro interno do servidor.' }),
  SERVICE_UNAVAILABLE: Object.freeze({ status: 503, message: 'Serviço temporariamente indisponível.' }),
  INVALID_REFERENCE: Object.freeze({ status: 422, message: 'Referência inválida.' }),
  DUPLICATE_RESOURCE: Object.freeze({ status: 409, message: 'Já existe um registro com esses dados.' }),
  RESOURCE_IN_USE: Object.freeze({ status: 409, message: 'O recurso possui vínculos que impedem a operação.' }),
});

const MENSAGENS_CAMPOS = Object.freeze({
  INVALID_VALUE: 'Valor inválido.',
  INVALID_ID: 'Informe um ID inteiro positivo.',
  INVALID_DATE: 'Informe uma data civil válida no formato AAAA-MM-DD.',
  UNKNOWN_FIELDS: 'Campos desconhecidos.',
  EMPTY_PATCH: 'Informe ao menos um campo para alterar.',
  REQUIRED: 'Campo obrigatório.',
});

const mensagensPermitidas = new Set(Object.values(MENSAGENS_CAMPOS));

function sanitizarCampos(campos) {
  if (!Array.isArray(campos)) return undefined;
  const usados = new Set();
  const resultado = [];

  for (const item of campos.slice(0, 50)) {
    let campo = typeof item?.field === 'string' ? item.field : 'body';
    if (
      campo.length > 120 ||
      !/^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*|\[\d+\])*$/.test(campo) ||
      /(?:^|\.)(?:__proto__|prototype|constructor)(?:\.|\[|$)/.test(campo)
    ) {
      campo = 'body';
    }
    campo = campo.replace(/(^|\.)senha(?:Hash|_hash)(?=\.|\[|$)/g, '$1senha');
    const mensagem = mensagensPermitidas.has(item?.message) ? item.message : MENSAGENS_CAMPOS.INVALID_VALUE;
    const chave = `${campo}:${mensagem}`;
    if (usados.has(chave)) continue;
    usados.add(chave);
    resultado.push({ field: campo, message: mensagem });
  }

  return resultado.length > 0 ? resultado : undefined;
}

class ErroAplicacao extends Error {
  constructor(codigo = 'INTERNAL_ERROR', { fields } = {}) {
    const codigoSeguro = Object.hasOwn(CATALOGO_ERROS, codigo) ? codigo : 'INTERNAL_ERROR';
    const definicao = CATALOGO_ERROS[codigoSeguro];
    super(definicao.message);
    this.name = 'ErroAplicacao';
    this.codigo = codigoSeguro;
    this.status = definicao.status;
    const campos = sanitizarCampos(fields);
    if (campos) this.fields = campos;
  }
}

module.exports = { ErroAplicacao, MENSAGENS_CAMPOS };
