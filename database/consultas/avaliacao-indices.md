# Avaliação das consultas e dos índices

Execução em PostgreSQL 16, com `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` dos
mesmos arquivos SQL carregados pelos repositórios. O teste
`testes/integracao/consultas-sql.test.js` registra os tipos de nós, índices,
quantidades retornadas e tempos; não exige um plano específico para passar.

Para reproduzir, configure `DATABASE_URL` e `TEST_DATABASE_URL` distintos e um
banco de teste migrado com nome terminado em `_teste` ou `_test`. Em `backend/`:

```bash
NODE_ENV=test node --env-file-if-exists=.env --test testes/integracao/consultas-sql.test.js
```

## Isolamento e volume

O ensaio cria tabelas temporárias com tipos, CHECKs e índices copiados das
migrations. Todas as leituras, a carga e o `ANALYZE` usam a mesma transação e
conexão; o rollback remove as tabelas temporárias. As FKs não são copiadas por
`LIKE`; os vínculos da carga são válidos, e as integrações HTTP continuam
exercitando o schema público real do banco de teste.

Foram utilizados 12.000 usuários, 5 gêneros, 1.200 livros, 6.000 ciclos,
30.000 participações, 24.000 encontros e 48.000 inscrições. IDs explícitos na
carga temporária evitam consumir as sequências das tabelas públicas. Nenhuma
estatística ou índice público é alterado pelo ensaio.

## Resultado observado

Uma execução completa em 01/11/2026 apresentou:

| Consulta | Linhas retornadas | Observação do plano | Tempo (ms) |
| --- | ---: | --- | ---: |
| Participantes do ciclo | 5 | Varredura das participações; PKs nos outros vínculos | 8,347 |
| Resumo do ciclo | 1 | Varredura das participações e agregação | 6,715 |
| Agenda futura | 4 | Índice único de inscrição por usuário/encontro e PKs | 0,351 |
| Livros com mínimo de ciclos | 12 | Hash join, varreduras e agregação do conjunto | 9,864 |
| Leitores sem participação | 12 | Merge anti join e índice único da participação | 0,711 |
| Histórico pessoal | 3 | Índice único da participação por usuário/ciclo e PKs | 0,441 |

O índice único `(usuario_id, ciclo_id)` atende consultas por usuário, mas não
tem o ciclo como primeira coluna. No mesmo ensaio foi criado **apenas na tabela
temporária** o candidato `(ciclo_id, id)`. Participantes e resumo passaram a usar
bitmap index scan, com tempos de 0,303 ms e 0,241 ms, respectivamente. Isso indica
utilidade para seleção de um ciclo nessa distribuição; o teste não cria uma
migration nem muda os índices permanentes.

Os tempos são amostras sob execução concorrente, com cache e dados sintéticos,
sem garantia de latência em produção. A agregação de todos os ciclos precisa
percorrer grande parte do conjunto; seu scan sequencial é coerente. Também não
se considera scan sequencial em tabelas pequenas um defeito automático.

## Integração e segurança

`participantes-ciclo.sql`, `agenda-leitor.sql` e `historico-leituras.sql` atendem
às rotas existentes de participantes, inscrições próprias e participações
próprias. Adaptadores preservam os campos HTTP e a paginação anteriores.
Resumo, utilização de livros e leitores sem adesão têm funções de repositório
sem novas rotas. Valores usam binds; caminhos dos arquivos vêm de uma lista
interna fechada.

Os três arquivos em `exemplos/` são executados por
`repositorios/exemplos.js` na mesma transação: INSERT, UPDATE do ID criado e
DELETE desse ID. O destino de teste é validado antes das escritas e o rollback
é obrigatório, inclusive após falha. O teste também utiliza texto com aspas
para verificar sua preservação como valor parametrizado.
