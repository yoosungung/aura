FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml /app/
COPY src /app/src
COPY skills /app/skills
RUN pip install --no-cache-dir .
USER nobody
ENTRYPOINT ["python", "-m", "aura_ai"]
