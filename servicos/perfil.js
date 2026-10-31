'use strict';

const bcrypt = require('bcrypt');
const { ErroAplicacao, MENSAGENS_CAMPOS } = require('../utilitarios/erro-aplicacao');
const { comContextoPersistencia } = require('../utilitarios/persistencia');
const { senhaValida } = require('../utilitarios/senha');
const { usuarioPublico } = require('./usuarios');

function exigirContaAtual(conta, identidade) {
  if (!conta || conta.situacao !== 'ATIVO' || conta.sessionVersion !== identidade.sessionVersion) {
    throw new ErroAplicacao('UNAUTHORIZED');
  }
}

function exigirIdentidade(identidade) {
  if (!Number.isInteger(identidade?.id) || identidade.id < 1 ||
    !Number.isInteger(identidade?.sessionVersion) || identidade.sessionVersion < 0) {
    throw new ErroAplicacao('UNAUTHORIZED');
  }
}

function dadoInvalido(field) {
  return new ErroAplicacao('VALIDATION_ERROR', {
    fields: [{ field, message: MENSAGENS_CAMPOS.INVALID_VALUE }],
  });
}

async function alterarNome(identidade, nome, Usuario) {
  exigirIdentidade(identidade);
  if (typeof nome !== 'string' || Array.from(nome.trim()).length < 2 || Array.from(nome).length > 100) {
    throw dadoInvalido('nome');
  }
  return comContextoPersistencia('atualizar', () => Usuario.sequelize.transaction(async (transaction) => {
    const conta = await Usuario.findByPk(identidade.id, {
      attributes: ['id', 'nome', 'email', 'perfil', 'situacao', 'sessionVersion'],
      transaction, lock: transaction.LOCK.UPDATE,
    });
    exigirContaAtual(conta, identidade);
    if (conta.nome !== nome) await conta.update({ nome }, { fields: ['nome'], transaction });
    return usuarioPublico(conta);
  }));
}

async function alterarSenha(identidade, { senhaAtual, novaSenha }, Usuario) {
  exigirIdentidade(identidade);
  if (typeof senhaAtual !== 'string' || senhaAtual.length === 0 || Buffer.byteLength(senhaAtual, 'utf8') > 72) {
    throw dadoInvalido('senhaAtual');
  }
  if (!senhaValida(novaSenha)) throw dadoInvalido('novaSenha');

  return comContextoPersistencia('atualizar', async () => {
    const atributos = ['id', 'situacao', 'senhaHash', 'sessionVersion'];
    const credenciais = Usuario.scope('credenciais');
    const conta = await credenciais.findByPk(identidade.id, { attributes: atributos });
    exigirContaAtual(conta, identidade);
    // Captura valores primitivos: a comparação e o hash custosos ficam fora do
    // bloqueio, sem manter uma transação aberta durante o trabalho do bcrypt.
    const hashValidado = conta.senhaHash;
    const versaoValidada = conta.sessionVersion;
    if (!await bcrypt.compare(senhaAtual, hashValidado)) throw dadoInvalido('senhaAtual');
    const senhaHash = await bcrypt.hash(novaSenha, 12);

    await Usuario.sequelize.transaction(async (transaction) => {
      const atual = await credenciais.findByPk(identidade.id, {
        attributes: atributos, transaction, lock: transaction.LOCK.UPDATE,
      });
      if (!atual || atual.situacao !== 'ATIVO') throw new ErroAplicacao('UNAUTHORIZED');
      // Confere também o hash: um escritor concorrente que não atualizou a
      // versão tampouco pode ser sobrescrito usando credenciais já ultrapassadas.
      if (atual.senhaHash !== hashValidado || atual.sessionVersion !== versaoValidada ||
        atual.sessionVersion >= 2147483647) throw new ErroAplicacao('CONFLICT');
      await atual.update({ senhaHash, sessionVersion: versaoValidada + 1 }, {
        fields: ['senhaHash', 'sessionVersion'], transaction,
      });
    });
    // O retorno ocorre somente após o commit. Limpeza física de sessões pertence
    // à camada HTTP e não pode sugerir que este commit foi desfeito.
    return { reauthenticate: true };
  });
}

module.exports = { alterarNome, alterarSenha };
