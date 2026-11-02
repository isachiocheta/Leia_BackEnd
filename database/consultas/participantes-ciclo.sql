-- Requisito 1: participantes de um ciclo com usuário, livro, páginas e progresso.
-- Bind: $ciclo (id positivo), $limite (1..50), $deslocamento (>=0).
-- Finalidade: consulta administrativa; apenas relações N:1 evitam multiplicação.
SELECT p.id, p.ciclo_id AS "cicloId", p.pagina_atual AS "paginaAtual",
  ROUND(p.pagina_atual::numeric * 100 / l.total_paginas, 2)::double precision AS percentual,
  (p.pagina_atual = l.total_paginas) AS concluida, p.concluida_em AS "concluidaEm",
  p.criado_em AS "criadoEm", p.atualizado_em AS "atualizadoEm",
  json_build_object('id', u.id, 'nome', u.nome) AS usuario,
  json_build_object('id', l.id, 'titulo', l.titulo, 'totalPaginas', l.total_paginas) AS livro
FROM participacoes_leitura p
JOIN usuarios u ON u.id = p.usuario_id
JOIN ciclos_leitura c ON c.id = p.ciclo_id
JOIN livros l ON l.id = c.livro_id
WHERE p.ciclo_id = $ciclo
ORDER BY p.id ASC LIMIT $limite OFFSET $deslocamento;
