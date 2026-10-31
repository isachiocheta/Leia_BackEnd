'use strict';

const { ErroAplicacao } = require('./erro-aplicacao');

function responderSemConteudo(resposta) {
  resposta.removeHeader('Content-Type');
  resposta.removeHeader('Content-Length');
  resposta.removeHeader('Transfer-Encoding');
  return resposta.status(204).end();
}

function validarStatusSucesso(status) {
  if (!Number.isInteger(status) || status < 200 || status > 299) {
    throw new ErroAplicacao('INTERNAL_ERROR');
  }
}

function representacaoPublica(dados) {
  try {
    // Valida o valor que de fato será enviado, incluindo toJSON de instâncias
    // Sequelize. Date, objetos circulares ou toJSON primitivo não viram detalhe.
    return JSON.parse(JSON.stringify(dados));
  } catch {
    throw new ErroAplicacao('INTERNAL_ERROR');
  }
}

function responderDetalhe(resposta, dados, status = 200) {
  validarStatusSucesso(status);
  if (status === 204) return responderSemConteudo(resposta);
  const publicos = representacaoPublica(dados);
  if (publicos === null || typeof publicos !== 'object' || Array.isArray(publicos)) {
    throw new ErroAplicacao('INTERNAL_ERROR');
  }
  return resposta.status(status).json({ data: publicos });
}

function responderLista(resposta, dados, meta, status = 200) {
  validarStatusSucesso(status);
  if (status === 204) return responderSemConteudo(resposta);
  if (
    !Array.isArray(dados) || !meta ||
    !Number.isSafeInteger(meta.page) || meta.page < 1 ||
    !Number.isSafeInteger(meta.pageSize) || meta.pageSize < 1 || meta.pageSize > 50 ||
    !Number.isSafeInteger(meta.total) || meta.total < 0
  ) {
    throw new ErroAplicacao('INTERNAL_ERROR');
  }
  const publicos = representacaoPublica(dados);
  if (!Array.isArray(publicos)) throw new ErroAplicacao('INTERNAL_ERROR');
  return resposta.status(status).json({
    data: publicos,
    meta: { page: meta.page, pageSize: meta.pageSize, total: meta.total },
  });
}

module.exports = { responderDetalhe, responderLista, responderSemConteudo };
