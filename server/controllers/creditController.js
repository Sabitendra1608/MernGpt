import Transaction from "../models/Transaction.js"
import Stripe from "stripe"
import User from "../models/User.js";

const plans = [
    {
        _id: "basic",
        name: "Basic",
        price: 10,
        credits: 100,
        features: ['100 text generations', '50 image generations', 'Standard support', 'Access to basic models']
    },
    {
        _id: "pro",
        name: "Pro",
        price: 20,
        credits: 500,
        features: ['500 text generations', '200 image generations', 'Priority support', 'Access to pro models', 'Faster response time']
    },
    {
        _id: "premium",
        name: "Premium",
        price: 30,
        credits: 1000,
        features: ['1000 text generations', '500 image generations', '24/7 VIP support', 'Access to premium models', 'Dedicated account manager']
    }
]

// api controller for getting all plans

export const getPlans = async (req, res) => {
    try {
        res.json({success: true, plans})
    } catch (error) {
        res.json({success:false, message: error.message})
    }
}

const stripe = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY)
    : null;

// api controller for purchasing a plan
export const purchasePlan = async (req, res) => {
    try {
        if (!stripe) {
    return res.json({
        success: false,
        message: "Payment system is currently unavailable"
    });
}


        const {planId} = req.body
        const userId = req.user._id
        const plan = plans.find((plan) => plan._id === planId)

        if(!plan) {
            return res.json({success: false, message: "Invalid Plan"})
        }

        // create a new transaction
        const transaction = await Transaction.create({
            userId: userId, 
            planId: plan._id,
            amount: plan.price,
            credits: plan.credits,
            isPaid: false
        })

        const {origin} = req.headers;

        const session = await stripe.checkout.sessions.create({
            line_items: [
                {
                price_data: {
                    currency: "usd",
                    unit_amount: plan.price*100,
                    product_data: {
                        name: plan.name
                    }
                },
                quantity: 1,
                },
            ],
            mode: 'payment',
            success_url: `${origin}/credits?payment=success&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${origin}/credits`,
            metadata: {transactionId: transaction._id.toString(), appId: 'merngpt'},
            expires_at: Math.floor(Date.now() / 1000) + 30*60,  // expires in 30 mins
        });

        res.json({success: true, url: session.url})

    } catch (error) {
        res.json({success: false, message: error.message})
    }
}

export const verifyPayment = async (req, res) => {
    try {

        if (!stripe) {
            return res.json({
                success: false,
                message: "Payment system is currently unavailable"
            });
        }

        const { sessionId } = req.body;

        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (session.payment_status === 'paid') {
            const { transactionId, appId } = session.metadata;

            if (appId === 'merngpt') {
                const transaction = await Transaction.findOne({ _id: transactionId, isPaid: false });

                if (transaction) {
                    await User.updateOne({ _id: transaction.userId }, { $inc: { credits: transaction.credits } });
                    transaction.isPaid = true;
                    await transaction.save();
                }
            }
            res.json({ success: true });
        } else {
            res.json({ success: false, message: 'Payment not completed' });
        }
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
}