-- Requisito 4: livros utilizados em pelo menos N ciclos, com GROUP BY e HAVING.
-- Bind: $minimo (inteiro >=1), $limite (1..50), $deslocamento (>=0).
-- Finalidade: relatório de utilização da obra, contando cada ciclo uma vez.
SELECT l.id, l.titulo, l.autor, l.genero_id AS "generoId", l.total_paginas AS "totalPaginas",
  COUNT(c.id)::integer AS "totalCiclos"
FROM livros l
JOIN ciclos_leitura c ON c.livro_id = l.id
GROUP BY l.id, l.titulo, l.autor, l.genero_id, l.total_paginas
HAVING COUNT(c.id) >= $minimo
ORDER BY "totalCiclos" DESC, l.id ASC LIMIT $limite OFFSET $deslocamento;
