'use strict';

const { Passport } = require('passport');
const { Strategy: EstrategiaLocal } = require('passport-local');
const bcrypt = require('bcrypt');
const { ErroAplicacao } = require('../utilitarios/erro-aplicacao');

// Hash de uma sequência aleatória descartada. A conta inexistente também passa
// por uma comparação assíncrona com o custo usado no bootstrap administrativo.
const HASH_INEXISTENTE = '$2b$12$fD2nFDWa5MmGGuIZbmUssODhCrwQ4EoQcNFseolsUPkX1xTNtM92C';
const atributosAtuais = ['id', 'nome', 'email', 'perfil', 'situacao', 'sessionVersion'];
const perfisPermitidos = new Set(['ADMIN_CLUBE', 'LEITOR']);

function versaoValida(versao) {
  return Number.isInteger(versao) && versao >= 0 && versao <= 2147483647;
}

function idValido(id) {
  return Number.isInteger(id) && id > 0 && id <= 2147483647;
}

function usuarioInterno(usuario) {
  return Object.fromEntries(atributosAtuais.map((atributo) => [atributo, usuario[atributo]]));
}

function contaDisponivel(usuario) {
  return usuario && usuario.situacao === 'ATIVO' && perfisPermitidos.has(usuario.perfil)
    && idValido(usuario.id) && versaoValida(usuario.sessionVersion);
}

function criarPassaporte({ obterUsuario, compararSenha = bcrypt.compare }) {
  if (typeof obterUsuario !== 'function' || typeof compararSenha !== 'function') {
    throw new TypeError('Informe o model de usuário e o comparador de senha.');
  }
  const passaporte = new Passport();

  passaporte.use(new EstrategiaLocal({
    usernameField: 'email', passwordField: 'senha', passReqToCallback: true,
  }, async (requisicao, email, senha, concluir) => {
    // passport-local também procura credenciais em query por padrão. A API
    // aceita somente o corpo, para não transportar senhas em URLs e históricos.
    if (!requisicao.body || !Object.hasOwn(requisicao.body, 'email') || !Object.hasOwn(requisicao.body, 'senha')
      || typeof email !== 'string' || typeof senha !== 'string'
      || email.trim().length === 0 || email.trim().length > 254
      || senha.length === 0 || Buffer.byteLength(senha, 'utf8') > 72) {
      return concluir(null, false);
    }

    let usuario;
    let confere;
    try {
      usuario = await obterUsuario().scope('credenciais').findOne({ where: { email: email.trim().toLowerCase() } });
      // A senha permanece exatamente como recebida, inclusive seus espaços.
      const hash = typeof usuario?.senhaHash === 'string' ? usuario.senhaHash : HASH_INEXISTENTE;
      confere = await compararSenha(senha, hash);
    } catch {
      return concluir(new ErroAplicacao('SERVICE_UNAVAILABLE'));
    }

    if (!confere || !contaDisponivel(usuario)) return concluir(null, false);
    return concluir(null, usuarioInterno(usuario));
  }));

  passaporte.serializeUser((usuario, concluir) => {
    if (!idValido(usuario?.id) || !versaoValida(usuario?.sessionVersion)) {
      return concluir(new ErroAplicacao('UNAUTHORIZED'));
    }
    return concluir(null, { id: usuario.id, sessionVersion: usuario.sessionVersion });
  });

  passaporte.deserializeUser(async (sessao, concluir) => {
    if (!sessao || typeof sessao !== 'object' || !Object.hasOwn(sessao, 'id')
      || !Object.hasOwn(sessao, 'sessionVersion') || !idValido(sessao.id)
      || !versaoValida(sessao.sessionVersion)) {
      return concluir(null, false);
    }

    let usuario;
    try {
      usuario = await obterUsuario().findByPk(sessao.id, { attributes: atributosAtuais });
    } catch {
      return concluir(new ErroAplicacao('SERVICE_UNAVAILABLE'));
    }
    if (!contaDisponivel(usuario) || usuario.sessionVersion !== sessao.sessionVersion) {
      return concluir(null, false);
    }
    return concluir(null, usuarioInterno(usuario));
  });

  return passaporte;
}

module.exports = { criarPassaporte };
