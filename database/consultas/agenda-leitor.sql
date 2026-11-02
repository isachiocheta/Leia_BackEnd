-- Requisito 3: agenda futura relacionando inscrição, encontro, ciclo e livro.
-- Bind: $usuario, $encontro (id ou NULL), $somenteFuturos (boolean), $agora
-- (instante), $limite (1..50), $deslocamento (>=0).
-- Finalidade: agenda pessoal. false mantém o histórico do endpoint existente;
-- true filtra início futuro, preservando a situação explícita, sem inferir presença.
SELECT i.id, i.encontro_id AS "encontroId", i.criado_em AS "criadoEm", i.atualizado_em AS "atualizadoEm",
  e.inicio_em AS "inicioEm",
  json_build_object('id', e.id, 'titulo', e.titulo, 'local', e.local, 'situacao', e.situacao) AS encontro,
  json_build_object('id', c.id, 'nome', c.nome, 'situacao', c.situacao,
    'dataInicio', c.data_inicio::text, 'dataFim', c.data_fim::text) AS ciclo,
  json_build_object('id', l.id, 'titulo', l.titulo, 'autor', l.autor) AS livro
FROM inscricoes_encontro i
JOIN encontros e ON e.id = i.encontro_id
JOIN ciclos_leitura c ON c.id = e.ciclo_id
JOIN livros l ON l.id = c.livro_id
WHERE i.usuario_id = $usuario AND ($encontro::integer IS NULL OR i.encontro_id = $encontro)
  AND (NOT $somenteFuturos::boolean OR e.inicio_em > $agora::timestamptz)
ORDER BY e.inicio_em ASC, i.id ASC LIMIT $limite OFFSET $deslocamento;
