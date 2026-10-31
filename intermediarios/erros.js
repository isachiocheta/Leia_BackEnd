'use strict';

const { ErroAplicacao } = require('../utilitarios/erro-aplicacao');
const { traduzirErroPersistencia } = require('../utilitarios/persistencia');

const codigosPorStatus = Object.freeze({
  400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND',
  409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE', 422: 'VALIDATION_ERROR',
  429: 'TOO_MANY_REQUESTS', 500: 'INTERNAL_ERROR', 503: 'SERVICE_UNAVAILABLE',
});

const tiposRequisicaoInvalida = new Set([
  'charset.unsupported', 'encoding.unsupported', 'request.aborted', 'request.size.invalid',
]);

function rotaNaoEncontrada(requisicao, resposta, proximo) {
  proximo(new ErroAplicacao('NOT_FOUND'));
}

function tratarErros(erro, requisicao, resposta, proximo) {
  if (resposta.headersSent) return proximo(erro);

  let seguro;
  try {
    if (erro?.type === 'entity.parse.failed') {
      seguro = new ErroAplicacao('INVALID_JSON');
    } else if (erro?.type === 'entity.too.large') {
      seguro = new ErroAplicacao('PAYLOAD_TOO_LARGE');
    } else if (tiposRequisicaoInvalida.has(erro?.type)) {
      seguro = new ErroAplicacao('BAD_REQUEST');
    } else {
      const traduzido = traduzirErroPersistencia(erro);
      if (traduzido instanceof ErroAplicacao) {
        // Reconstrói o erro para impedir que propriedades alteradas depois da
        // criação introduzam mensagens, fields ou códigos fora do catálogo.
        seguro = new ErroAplicacao(traduzido.codigo, { fields: traduzido.fields });
      } else {
        const status = traduzido?.status ?? traduzido?.statusCode;
        seguro = new ErroAplicacao(Number.isInteger(status) && Object.hasOwn(codigosPorStatus, status)
          ? codigosPorStatus[status]
          : 'INTERNAL_ERROR');
      }
    }
  } catch {
    // Nem um erro malformado ou um getter defeituoso pode escapar ao handler
    // padrão do Express, que poderia expor detalhes em desenvolvimento.
    seguro = new ErroAplicacao('INTERNAL_ERROR');
  }

  if (seguro.status === 500) {
    // O erro original pode conter senha, parâmetros SQL ou credenciais.
    console.error('Erro interno ao processar requisição.');
  }

  const corpo = { code: seguro.codigo, message: seguro.message };
  if (seguro.fields) corpo.fields = seguro.fields;
  return resposta.status(seguro.status).json({ error: corpo });
}

module.exports = { rotaNaoEncontrada, tratarErros };
