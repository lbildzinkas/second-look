def apply_discount(order):
    if order.total > 100:
        order.total -= 10
        order.flag = True
    return order
