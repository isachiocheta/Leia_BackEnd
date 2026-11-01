'use strict';

const { ErroAplicacao } = require('../utilitarios/erro-aplicacao');
const { dataEmSaoPaulo } = require('../utilitarios/datas-civis');

function conferirCicloLiberado(ciclo, instante) {
  const hoje = dataEmSaoPaulo(instante);
  if (ciclo.situacao !== 'EM_ANDAMENTO' || hoje < ciclo.dataInicio || hoje > ciclo.dataFim) throw new ErroAplicacao('CONFLICT');
}

async function conferirLeitor(identidade, conexao, transaction) {
  if (!Number.isInteger(identidade?.id) || identidade.id < 1 || !Number.isInteger(identidade?.sessionVersion) || identidade.sessionVersion < 0) {
    throw new ErroAplicacao('UNAUTHORIZED');
  }
  // Os pais do domínio são bloqueados antes do usuário. SHARE mantém a conta
  // ativa e a versão válida até o commit diante de desativação/troca de senha.
  const usuario = await conexao.models.Usuario.findByPk(identidade.id, {
    attributes: ['id', 'perfil', 'situacao', 'sessionVersion'], transaction, lock: transaction.LOCK.SHARE,
  });
  if (!usuario || usuario.situacao !== 'ATIVO' || usuario.sessionVersion !== identidade.sessionVersion) throw new ErroAplicacao('UNAUTHORIZED');
  if (usuario.perfil !== 'LEITOR') throw new ErroAplicacao('FORBIDDEN');
}

module.exports = { conferirCicloLiberado, conferirLeitor };
