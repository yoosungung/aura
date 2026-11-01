from virtual_client.mcp_mock import FIXTURES, FixtureStore, lookup_order, lookup_shipping, refund, set_scenario


def test_five_fixtures_exist():
    assert set(FIXTURES) == {
        "cancel-in-transit",
        "lost-package",
        "return-fee",
        "damaged-exchange",
        "coupon-retro",
    }


def test_lost_package_matches_phone_and_delivered():
    store = FixtureStore("lost-package")
    row = lookup_order(store, order_id="", phone="010-5555-0001", name="")
    assert row["order_id"]
    assert row["customer"]["phone"] == "010-5555-0001"
    ship = lookup_shipping(store, order_id=row["order_id"])
    assert ship["status"] == "delivered"


def test_cancel_in_transit_and_coupon_and_damaged():
    set_scenario("cancel-in-transit")
    store = FixtureStore("cancel-in-transit")
    assert lookup_shipping(store, "ORD-CANCEL")["status"] == "in_transit"
    assert lookup_order(store, "ORD-CANCEL")["status"] == "paid"

    dmg = FixtureStore("damaged-exchange")
    order = lookup_order(dmg, "ORD-GLASS")
    assert order["shipping"]["status"] == "delivered"
    assert order["sku"]["stock"] == 0

    coup = FixtureStore("coupon-retro")
    order = lookup_order(coup, "ORD-WELCOME")
    assert order["coupon"]["code"] == "WELCOME10"
    assert order["coupon"]["pg_partial_cancel"] is False
    assert order["coupon"]["delta"] == 15000

    fee = FixtureStore("return-fee")
    assert lookup_order(fee, "ORD-SHOE")["policy"]["return_shipping_krw"] == 6000

    out = refund(store, 15000, "고객 요청")
    assert out["executed"] is True
    assert out["amount"] == 15000
