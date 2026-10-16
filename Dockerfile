FROM python:3.12-slim
WORKDIR /app
COPY . /app
RUN pip install --no-cache-dir edge_tts aiohttp
ENV WX_HOST=0.0.0.0
ENV WANXIANG_NO_BROWSER=1
EXPOSE 10000
CMD ["python", "server.py"]
