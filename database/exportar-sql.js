'use strict';

const { spawn } = require('node:child_process');
const { readdir, mkdir, writeFile, rename } = require('node:fs/promises');
const caminho = require('node:path');
const { criarBancoTemporario } = require('./banco-temporario');

const diretorioBackend = caminho.resolve(__dirname, '..');

function executarPrograma(programa, argumentos, ambiente) {
  return new Promise((resolver, rejeitar) => {
    const filho = spawn(programa, argumentos, { cwd: diretorioBackend, env: ambiente, stdio: ['ignore', 'pipe', 'pipe'] });
    filho.stdout.setEncoding('utf8');
    let saida = ''; let tamanho = 0;
    const prazo = setTimeout(() => filho.kill('SIGKILL'), 30_000);
    filho.stdout.on('data', (dados) => { tamanho += Buffer.byteLength(dados); if (tamanho > 5 * 1024 * 1024) filho.kill('SIGKILL'); else saida += dados; });
    // Drenar stderr sem imprimi-lo: ferramentas/driver podem incluir credenciais.
    filho.stderr.resume();
    filho.on('error', () => { clearTimeout(prazo); rejeitar(new Error('Ferramenta PostgreSQL/CLI indisponível.')); });
    filho.on('close', (codigo) => { clearTimeout(prazo); if (codigo === 0) resolver(saida); else rejeitar(new Error('Falha na ferramenta PostgreSQL/CLI. Confira PATH e permissões do banco de teste.')); });
  });
}

function ambientePg(variaveis) {
  const endereco = new URL(variaveis.TEST_DATABASE_URL);
  const ambiente = { ...variaveis, PGHOST: endereco.hostname.replace(/^\[|\]$/g, ''), PGPORT: endereco.port || '5432',
    PGDATABASE: decodeURIComponent(endereco.pathname.slice(1)), PGUSER: decodeURIComponent(endereco.username), PGPASSWORD: decodeURIComponent(endereco.password),
    PGSSLMODE: endereco.searchParams.get('sslmode') || 'prefer' };
  for (const nome of ['PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS']) delete ambiente[nome];
  return ambiente;
}

async function instalarReferencia(variaveis) {
  const ambiente = { ...variaveis };
  for (const nome of Object.keys(ambiente)) if (/^(ADMIN_|DEMO_)/.test(nome)) delete ambiente[nome];
  for (const comando of ['db:migrate', 'db:seed:all']) await executarPrograma(process.execPath, ['database/executar-cli.js', comando], ambiente);
}

function limparDump(sql) {
  return sql.split('\n').filter((linha) => !/^\\(?:un)?restrict\b/.test(linha)).join('\n')
    .replace(/^CREATE SCHEMA public;$/m, 'CREATE SCHEMA IF NOT EXISTS public;');
}

async function gerarArtefatos(variaveis = process.env) {
  const temporario = await criarBancoTemporario('exportacao', variaveis);
  try {
    // O banco nasceu vazio nesta chamada. Nunca executa bootstrap ou demo.
    await instalarReferencia(temporario.variaveis);
    const conexao = temporario.conexao;
    const migracoes = (await readdir(caminho.join(__dirname, 'migracoes'))).filter((nome) => nome.endsWith('.js')).sort();
    const [historico] = await conexao.query('SELECT name FROM sequelize_meta ORDER BY name');
    if (JSON.stringify(historico.map((linha) => linha.name)) !== JSON.stringify(migracoes)) throw new Error('Histórico de migrations não corresponde aos arquivos.');
    const [semeadores] = await conexao.query('SELECT name FROM sequelize_seeds ORDER BY name');
    if (JSON.stringify(semeadores) !== JSON.stringify([{ name: '20261030061000-carregar-generos-referencia.js' }])) throw new Error('Histórico de referência inesperado.');
    for (const tabela of ['usuarios', 'sessoes', 'livros', 'ciclos_leitura', 'encontros', 'participacoes_leitura', 'inscricoes_encontro', 'cargas_demonstracao']) {
      const [linhas] = await conexao.query(`SELECT 1 FROM "${tabela}" LIMIT 1`);
      if (linhas.length) throw new Error('Banco de exportação contém dados não permitidos.');
    }
    const [referencias] = await conexao.query('SELECT nome FROM generos ORDER BY nome');
    const esperados = ['Aventura', 'Conto', 'Fábula', 'Ficção científica', 'Poesia', 'Romance'];
    if (JSON.stringify(referencias.map((linha) => linha.nome).sort()) !== JSON.stringify(esperados.sort())) throw new Error('Referências inesperadas.');
    const ambiente = ambientePg(temporario.variaveis);
    const opcoes = ['--no-owner', '--no-privileges', '--no-comments', '--no-security-labels', '--schema=public'];
    const ddl = limparDump(await executarPrograma('pg_dump', [...opcoes, '--schema-only'], ambiente));
    const dados = limparDump(await executarPrograma('pg_dump', [...opcoes, '--data-only', '--column-inserts'], ambiente));
    const referencia = []; const metadata = [];
    for (const linha of dados.split('\n')) {
      const insercao = linha.match(/^INSERT INTO public\.([a-z_]+) /);
      if (insercao) {
        if (insercao[1] === 'generos') referencia.push(linha);
        else if (['sequelize_meta', 'sequelize_seeds', 'generos_semeados'].includes(insercao[1])) metadata.push(linha);
        else throw new Error('Tentativa de exportar dados não permitidos.');
      } else if (/^SELECT pg_catalog.setval\(/.test(linha)) referencia.push(linha);
    }
    if (referencia.filter((linha) => linha.startsWith('INSERT')).length !== 6 || metadata.filter((linha) => linha.startsWith('INSERT')).length !== migracoes.length + 7) throw new Error('Dump de dados incompleto.');
    return {
      '001_schema.sql': `-- Leia+: DDL físico gerado por pg_dump de banco temporário vazio migrado.\n-- Autoridade: database/migracoes; inclui domínio, sequências, constraints, índices,\n-- sessões e controles técnicos. Sem dados. Aplicar primeiro, em banco vazio.\n-- Não contém owners, ACLs, credenciais nem DDL repetido nos arquivos seguintes.\nBEGIN;\n${ddl}\nCOMMIT;\n`,
      '002_reference_data.sql': `-- Leia+: somente os seis gêneros da referência e o estado de todas as sequências.\n-- Origem: banco temporário com migrations + db:seed:all; nenhum bootstrap/demo.\n-- Aplicar depois de 001_schema.sql, uma única vez na instalação vazia.\n-- Sequências sem dados mantêm is_called=false; generos continua após os IDs importados.\nBEGIN;\n${referencia.join('\n')}\nCOMMIT;\n`,
      '003_migration_metadata.sql': `-- Leia+: apenas histórico real do sequelize-cli e proveniência da referência.\n-- sequelize_meta: migrations aplicadas; sequelize_seeds: seeder básico executado;\n-- generos_semeados: IDs efetivamente criados por ele, preservando sua reversão.\n-- Aplicar depois de 002_reference_data.sql. Nenhum registro de demo/usuário/sessão.\n-- As tabelas já foram definidas em 001; não há DDL neste arquivo.\nBEGIN;\n${metadata.join('\n')}\nCOMMIT;\n`,
    };
  } finally { await temporario.encerrar(); }
}

async function exportarSql(variaveis = process.env) {
  const artefatos = await gerarArtefatos(variaveis);
  const diretorio = caminho.join(__dirname, 'sql'); await mkdir(diretorio, { recursive: true });
  for (const [nome, sql] of Object.entries(artefatos)) {
    const temporario = caminho.join(diretorio, `.${nome}.${process.pid}.tmp`);
    await writeFile(temporario, sql); await rename(temporario, caminho.join(diretorio, nome));
  }
}

if (require.main === module) exportarSql().then(() => console.info('Três artefatos SQL gerados de banco temporário contendo somente referência.')).catch(() => {
  console.error('Exportação SQL não concluída. Confira NODE_ENV=test, URLs distintas, pg_dump no PATH e permissão para criar bancos temporários.'); process.exitCode = 1;
});

module.exports = { gerarArtefatos, exportarSql, instalarReferencia };
