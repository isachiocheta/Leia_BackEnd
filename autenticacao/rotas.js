'use strict';

const express = require('express');
const session = require('express-session');
const { body, validationResult } = require('express-validator');
const { criarPassaporte } = require('./passaporte');
const { criarArmazenamentoSessoes } = require('./armazenamento-sessoes');
const { obterTokenCsrf, protegerCsrf } = require('./csrf');
const { criarLimiteTentativas } = require('./limite-tentativas');
const { rejeitarCamposDesconhecidos, validarRequisicao, selecionarCamposPermitidos } = require('../validacao/requisicao');
const { senhaValida } = require('../utilitarios/senha');
const { cadastrarLeitor, usuarioPublico } = require('../servicos/usuarios');
const { ErroAplicacao } = require('../utilitarios/erro-aplicacao');
const { responderDetalhe, responderSemConteudo } = require('../utilitarios/respostas');

function exigirAutenticacao(requisicao, resposta, proximo) {
  return requisicao.isAuthenticated() ? proximo() : proximo(new ErroAplicacao('UNAUTHORIZED'));
}

function exigirPerfil(...perfis) {
  if (!perfis.length || perfis.some((perfil) => !['ADMIN_CLUBE', 'LEITOR'].includes(perfil))) {
    throw new TypeError('Informe perfis internos válidos.');
  }
  return (requisicao, resposta, proximo) => (
    perfis.includes(requisicao.user?.perfil) ? proximo() : proximo(new ErroAplicacao('FORBIDDEN'))
  );
}

// A ordem é parte do contrato: autenticação e perfil precedem a verificação CSRF.
function protegerRota(...perfis) {
  return [exigirAutenticacao, exigirPerfil(...perfis), protegerCsrf];
}

function criarAutenticacao({ configuracao, pool, obterUsuario, agora = Date.now, limiteLogin = {}, limiteCadastro = {} }) {
  const armazenamento = criarArmazenamentoSessoes({ pool });
  const passaporte = criarPassaporte({ obterUsuario });
  const roteador = express.Router();
  const identificar = express.Router();
  const iniciarSessao = session({
    name: configuracao.nomeCookie,
    secret: configuracao.segredo,
    store: armazenamento,
    resave: false,
    saveUninitialized: false,
    rolling: false,
    unset: 'destroy',
    cookie: { ...configuracao.cookie },
  });
  const falhaPersistencia = () => new ErroAplicacao('SERVICE_UNAVAILABLE');
  const limparCookie = (requisicao, resposta) => {
    const { maxAge, expires, ...opcoes } = configuracao.cookie;
    resposta.clearCookie(configuracao.nomeCookie, { ...opcoes, secure: opcoes.secure || requisicao.secure });
  };
  function fixarPrazo(sessao) {
    sessao.cookie.expires = new Date(sessao.expiraEm);
    // Express-session chama touch ao responder, mesmo com rolling:false.
    // Preservamos o prazo absoluto em vez do resetMaxAge deslizante padrão.
    Object.defineProperty(sessao, 'touch', {
      configurable: true,
      value() { this.cookie.expires = new Date(this.expiraEm); return this; },
    });
  }
  function iniciarPrazo(sessao) {
    sessao.iniciadaEm = agora();
    sessao.expiraEm = sessao.iniciadaEm + configuracao.prazoMs;
    fixarPrazo(sessao);
  }
  function invalidarSessao(requisicao, resposta, proximo) {
    requisicao.session.regenerate((erro) => {
      if (erro) return proximo(falhaPersistencia());
      limparCookie(requisicao, resposta);
      return proximo();
    });
  }
  identificar.use((requisicao, resposta, proximo) => {
    iniciarSessao(requisicao, resposta, (erro) => proximo(erro ? falhaPersistencia() : undefined));
  });
  identificar.use((requisicao, resposta, proximo) => {
    const sessao = requisicao.session;
    if (requisicao.secure) sessao.cookie.secure = true;
    const temEstado = sessao.passport || sessao.csrfToken || sessao.expiraEm !== undefined;
    if (temEstado && (
      !Number.isSafeInteger(sessao.iniciadaEm) || !Number.isSafeInteger(sessao.expiraEm) ||
      sessao.expiraEm - sessao.iniciadaEm !== configuracao.prazoMs || agora() >= sessao.expiraEm
    )) return invalidarSessao(requisicao, resposta, proximo);
    if (temEstado) fixarPrazo(sessao);
    return proximo();
  });
  identificar.use(passaporte.initialize());
  identificar.use((requisicao, resposta, proximo) => {
    const tinhaIdentidade = Object.hasOwn(requisicao.session.passport || {}, 'user');
    passaporte.session()(requisicao, resposta, (erro) => {
      if (erro) return proximo(falhaPersistencia());
      if (tinhaIdentidade && !requisicao.user) return invalidarSessao(requisicao, resposta, proximo);
      return proximo();
    });
  });
  roteador.use(identificar);

  roteador.get('/csrf', (requisicao, resposta, proximo) => {
    if (requisicao.session.expiraEm === undefined) iniciarPrazo(requisicao.session);
    const csrfToken = obterTokenCsrf(requisicao.session);
    requisicao.session.save((erro) => {
      if (erro) return proximo(falhaPersistencia());
      return responderDetalhe(resposta, { csrfToken });
    });
  });
  roteador.post('/login',
    criarLimiteTentativas({ ...limiteLogin, agora }),
    protegerCsrf,
    rejeitarCamposDesconhecidos(['email', 'senha']),
    body('email').isString().bail().trim().toLowerCase().isLength({ min: 3, max: 254 }).isEmail(),
    body('senha').custom((senha) => typeof senha === 'string' && senha.length > 0 && Buffer.byteLength(senha, 'utf8') <= 72),
    (requisicao, resposta, proximo) => {
      // Recusa uniforme também para credenciais malformadas, sem ecoar valores.
      if (!validationResult(requisicao).isEmpty()) return proximo(new ErroAplicacao('UNAUTHORIZED'));
      return passaporte.authenticate('local', (erro, usuario) => {
        if (erro) return proximo(erro);
        if (!usuario) return proximo(new ErroAplicacao('UNAUTHORIZED'));
        // req.logIn do Passport 0.7 regenera o SID e não conserva o token anônimo.
        return requisicao.logIn(usuario, (falha) => {
          if (falha) return proximo(falhaPersistencia());
          iniciarPrazo(requisicao.session);
          if (requisicao.secure) requisicao.session.cookie.secure = true;
          return requisicao.session.save((erroSalvar) => {
            if (erroSalvar) return proximo(falhaPersistencia());
            return responderDetalhe(resposta, usuarioPublico(usuario));
          });
        });
      })(requisicao, resposta, proximo);
    });
  roteador.post('/cadastro',
    criarLimiteTentativas({ maximo: 5, ...limiteCadastro, agora }),
    protegerCsrf,
    rejeitarCamposDesconhecidos(['nome', 'email', 'senha']),
    body('nome').isString().bail().trim().custom((nome) => Array.from(nome).length >= 2 && Array.from(nome).length <= 100),
    body('email').isString().bail().trim().toLowerCase().isLength({ max: 254 }).isEmail(),
    body('senha').custom(senhaValida),
    validarRequisicao,
    async (requisicao, resposta) => {
      const dados = selecionarCamposPermitidos(requisicao, ['nome', 'email', 'senha']);
      responderDetalhe(resposta, await cadastrarLeitor(dados, obterUsuario()), 201);
    });
  roteador.get('/me', ...protegerRota('ADMIN_CLUBE', 'LEITOR'), (requisicao, resposta) => {
    responderDetalhe(resposta, usuarioPublico(requisicao.user));
  });
  roteador.post('/logout', ...protegerRota('ADMIN_CLUBE', 'LEITOR'), (requisicao, resposta, proximo) => {
    requisicao.logout((erro) => {
      if (erro) return proximo(falhaPersistencia());
      requisicao.session.destroy((falha) => {
        if (falha) return proximo(falhaPersistencia());
        limparCookie(requisicao, resposta);
        return responderSemConteudo(resposta);
      });
    });
  });
  return { roteador, identificar, encerrar: () => armazenamento.close() };
}

module.exports = { criarAutenticacao, exigirAutenticacao, exigirPerfil, protegerRota };
