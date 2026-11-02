-- Requisito 6: histórico pessoal relacionando participação, ciclo, livro e gênero.
-- Bind: $usuario, $ciclo (id ou NULL), $limite (1..50), $deslocamento (>=0).
-- Finalidade: preservar leituras encerradas. O gênero enriquece o repositório;
-- o adaptador HTTP mantém os campos do contrato existente.
SELECT p.id, p.ciclo_id AS "cicloId", p.pagina_atual AS "paginaAtual",
  ROUND(p.pagina_atual::numeric * 100 / l.total_paginas, 2)::double precision AS percentual,
  (p.pagina_atual = l.total_paginas) AS concluida, p.concluida_em AS "concluidaEm",
  p.criado_em AS "criadoEm", p.atualizado_em AS "atualizadoEm",
  json_build_object('id', c.id, 'nome', c.nome, 'situacao', c.situacao,
    'dataInicio', c.data_inicio::text, 'dataFim', c.data_fim::text) AS ciclo,
  json_build_object('id', l.id, 'titulo', l.titulo, 'totalPaginas', l.total_paginas) AS livro,
  json_build_object('id', g.id, 'nome', g.nome) AS genero
FROM participacoes_leitura p
JOIN ciclos_leitura c ON c.id = p.ciclo_id
JOIN livros l ON l.id = c.livro_id
JOIN generos g ON g.id = l.genero_id
WHERE p.usuario_id = $usuario AND ($ciclo::integer IS NULL OR p.ciclo_id = $ciclo)
ORDER BY p.id DESC LIMIT $limite OFFSET $deslocamento;
