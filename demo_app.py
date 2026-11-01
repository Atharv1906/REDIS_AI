import json
import os

import redis

cache = redis.Redis(
    host=os.getenv("REDIS_HOST", "localhost"),
    port=int(os.getenv("REDIS_PORT", "6379")),
    decode_responses=True,
    protocol=2,
    socket_connect_timeout=5,
    socket_timeout=5,
)

# Demonstration database function.
# Replace this with a real database query.
def get_product_from_database(product_id):
    return {
        "id": product_id,
        "name": "Laptop",
        "price": 65000,
    }


def get_product(product_id):
    key = f"product:{product_id}"

    cached = cache.get(key)

    if cached is not None:
        print("Cache hit")
        return json.loads(cached)

    print("Cache miss")
    product = get_product_from_database(product_id)

    cache.set(key, json.dumps(product), ex=300)
    return product


if __name__ == "__main__":
    print(get_product(101))
    print(get_product(101))
    print(get_product(102))
    print(get_product(102))