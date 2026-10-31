'use strict';

const { NOME_COOKIE_SESSAO } = require('../configuracao/sessao');

async function encerrarSessaoAposTrocaSenha(requisicao, resposta) {
  const sessao = requisicao.session;
  resposta.clearCookie(NOME_COOKIE_SESSAO, {
    path: '/', httpOnly: true, sameSite: 'lax', secure: Boolean(sessao?.cookie?.secure || requisicao.secure),
  });
  delete requisicao.user;
  // Impede saves/touches ou uma segunda destruição automática pelo
  // express-session ao enviar a resposta, inclusive se o store falhar abaixo.
  delete requisicao.session;
  requisicao.sessionID = undefined;
  if (!sessao) return;
  await new Promise((resolver) => {
    const concluir = (erro) => {
      if (erro) console.warn('Senha alterada; a limpeza física da sessão revogada ficou pendente.');
      resolver();
    };
    try { sessao.destroy(concluir); }
    catch { concluir(true); }
  });
}

module.exports = { encerrarSessaoAposTrocaSenha };
