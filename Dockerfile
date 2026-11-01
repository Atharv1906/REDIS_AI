FROM python:3.13-slim
WORKDIR /app
RUN useradd --create-home --uid 10001 cache
COPY resp.py store.py server.py ./
USER cache
EXPOSE 6379
CMD ["python", "server.py", "--host", "0.0.0.0"]
