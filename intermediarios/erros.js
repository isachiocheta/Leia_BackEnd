'use strict';

function rotaNaoEncontrada(requisicao, resposta, proximo) {
  const erro = new Error('Rota não encontrada.');
  erro.status = 404;
  proximo(erro);
}

function tratarErros(erro, requisicao, resposta, proximo) {
  if (resposta.headersSent) {
    return proximo(erro);
  }

  let status = Number.isInteger(erro.status) && erro.status >= 400 && erro.status <= 599
    ? erro.status
    : 500;
  let mensagem;

  if (erro.type === 'entity.parse.failed') {
    status = 400;
    mensagem = 'JSON inválido.';
  } else if (erro.type === 'entity.too.large') {
    status = 413;
    mensagem = 'Corpo da requisição excede o limite de 100 KB.';
  } else if (status === 404) {
    mensagem = 'Rota não encontrada.';
  } else if (status < 500) {
    mensagem = 'Requisição inválida.';
  } else {
    mensagem = 'Erro interno do servidor.';
    console.error('Erro ao processar requisição:', erro);
  }

  return resposta.status(status).json({ erro: { mensagem } });
}

module.exports = { rotaNaoEncontrada, tratarErros };
